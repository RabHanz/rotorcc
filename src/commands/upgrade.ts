/**
 * `rotorcc upgrade` — bring this machine up to the newest rotorcc, and prove
 * the result actually runs.
 *
 * Every fix rotorcc ever ships reaches an operator's machines through this
 * command, so it is the one that most has to refuse rather than improvise.
 *
 * ## Two shapes, detected rather than assumed
 *
 * | shape        | how it got there                     | how it upgrades                       |
 * | ------------ | ------------------------------------ | ------------------------------------- |
 * | **package**  | `npm install -g rotorcc`             | reinstall from the registry           |
 * | **checkout** | `git clone` + build, binary linked   | fast-forward, reinstall deps, rebuild |
 *
 * The shape is worked out from where the running binary actually lives — inside
 * a global `node_modules/rotorcc/`, or inside a git worktree's `dist/` — and the
 * chosen mode is stated in the output. Guessing wrong here means upgrading one
 * installation while the operator keeps running another, which is the failure
 * that makes every later bug report be about code that is not deployed.
 *
 * ## What the checkout path refuses
 *
 * - a **dirty tree** — uncommitted work is somebody's afternoon, and no upgrade
 *   is worth guessing about it
 * - a **diverged branch** — local commits the remote does not have, plus remote
 *   commits we do not. Fast-forward only, always; there is no merge, no rebase
 *   and no reset in this file, so there is no way for it to lose a commit
 * - a detached HEAD, or a branch tracking nothing
 *
 * ## How it stays safe while the watcher is running
 *
 * Two mechanisms, and together they are the whole answer to "what if a tick
 * fires mid-upgrade":
 *
 * 1. **The build is staged, and published by rename.** `tsc` writes into
 *    `.rotorcc-upgrade/`, that build is run once to prove it starts, and only
 *    then does it become `dist/`. A compile error, a broken dependency or a
 *    killed process therefore cannot leave a half-written `dist` — the live one
 *    was never opened. Publication is two renames within one filesystem, so the
 *    window in which `dist` does not exist is sub-millisecond rather than the
 *    several seconds a `tsc` build takes, and if the second rename fails the
 *    first is undone immediately. (In package mode the package manager owns the
 *    equivalent swap; it installs to a staging directory and renames too.)
 *
 * 2. **The upgrade holds rotorcc's own tick lock.** A watcher tick that lands
 *    inside the upgrade finds the lock held, declines, and exits 2 — the same
 *    path it already takes when a hook is checkpointing. It is not stopped and
 *    it is not silently skipped: it says so. This is deliberately NOT
 *    "stop the timer and start it again afterwards", because a timer that fails
 *    to come back leaves a machine unwatched with nothing on screen about it.
 *
 * Nothing here prints or handles a credential.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

import { type RunResult, run } from '../core/proc.js';
import type { Config } from '../config/schema.js';
import type { Store } from '../core/state.js';
import { VERSION } from '../version.js';

/** The registry name. One constant so a rename cannot half-happen. */
export const PACKAGE_NAME = 'rotorcc';
/** Where the staged build is assembled, relative to the repository root. */
export const STAGING_DIR = '.rotorcc-upgrade';
/** Where the outgoing `dist` is parked for the instant between the two renames. */
export const RETIRED_DIR = '.rotorcc-dist-previous';

export type StepStatus = 'ok' | 'skipped' | 'refused' | 'failed';

export interface UpgradeStep {
  name: string;
  status: StepStatus;
  detail: string;
}

export type UpgradeMode = 'package' | 'checkout' | 'unknown';

export interface UpgradeReport {
  /** False when anything refused or failed. */
  ok: boolean;
  /** True when a newer rotorcc was actually installed. */
  applied: boolean;
  /** True when there was something newer to install. */
  updateAvailable: boolean;
  action: 'check' | 'apply';
  /** Which installation shape was detected. */
  mode: UpgradeMode;
  /** The git checkout, in checkout mode. */
  repoRoot: string | null;
  /** The installed package directory, in package mode. */
  packageRoot: string | null;
  branch: string | null;
  upstream: string | null;
  before: { commit: string | null; version: string | null };
  after: { commit: string | null; version: string | null };
  /** The newest version on the registry, in package mode. */
  latestPublished: string | null;
  steps: UpgradeStep[];
  notes: string[];
}

export interface UpgradeOptions {
  /** The resolved path of the running CLI. */
  binaryPath: string;
  /** Override the located checkout. Tests use it; humans should not need to. */
  repoRoot?: string;
  /** Report what is available and change nothing. */
  check: boolean;
  dryRun: boolean;
  json: boolean;
  config: Config;
  store: Store;
  configPath?: string;
  out: (line: string) => void;
  /** Every subprocess goes through here, so a test never spawns anything. */
  exec?: (argv: string[], options?: { cwd?: string; timeoutMs?: number }) => Promise<RunResult>;
  /** The node binary used to run a freshly built CLI. */
  nodePath?: string;
}

/**
 * Exit codes, chosen so a script can branch without parsing prose.
 *
 * `--check` deliberately reports "an upgrade is available" as 1 rather than as
 * success-with-a-message: the caller of `--check` is asking a yes/no question,
 * and `if rotorcc upgrade --check; then` should mean "already current".
 *
 * | code | `--check`                    | apply                              |
 * | ---- | ---------------------------- | ---------------------------------- |
 * |  `0` | already current              | upgraded, or already current       |
 * |  `1` | an upgrade is available      | refused or failed; nothing applied |
 * |  `2` | cannot tell (see the steps)  | could not even start               |
 */
export const UPGRADE_OK = 0;
export const UPGRADE_AVAILABLE_OR_FAILED = 1;
export const UPGRADE_UNKNOWN = 2;

// --------------------------------------------------------------- detection

export type InstallShape =
  | { kind: 'package'; packageRoot: string; manager: 'npm' | 'pnpm' }
  | { kind: 'checkout'; root: string }
  | { kind: 'unknown'; detail: string };

/**
 * Work out how this rotorcc was installed, from where its binary really is.
 *
 * Package first: a global install lives under `…/node_modules/rotorcc/`, and
 * that segment is unambiguous in a way that "is there a .git above it" is not —
 * a checkout that happens to sit inside somebody's node_modules would otherwise
 * be fetched and rebuilt by a command the operator asked to update a package.
 */
export function detectInstall(
  binaryPath: string,
  exists: (path: string) => boolean = existsSync,
  readPackageName: (path: string) => string | null = defaultPackageName,
): InstallShape {
  const normalised = binaryPath.replace(/\\/g, '/');
  const marker = `/node_modules/${PACKAGE_NAME}/`;
  const index = normalised.indexOf(marker);
  if (index !== -1) {
    // Slice the ORIGINAL string: the normalised copy is the same length, so the
    // index is valid in both and the native separators survive.
    const packageRoot = binaryPath.slice(0, index + marker.length - 1);
    return {
      kind: 'package',
      packageRoot,
      // pnpm's global store puts `pnpm` in the path; npm's prefix does not.
      manager: /(^|\/|\\)\.?pnpm(\/|\\)/.test(normalised) ? 'pnpm' : 'npm',
    };
  }

  const distDir = dirname(binaryPath);
  if (basename(distDir) !== 'dist') {
    return {
      kind: 'unknown',
      detail:
        `this rotorcc runs from ${binaryPath}, which is neither a global package install ` +
        "nor a checkout's dist/cli.js — upgrade does not know how to update it",
    };
  }
  const root = dirname(distDir);
  if (!exists(join(root, '.git'))) {
    return {
      kind: 'unknown',
      detail:
        `${root} has no .git and is not inside node_modules, so rotorcc cannot tell how this ` +
        `copy was installed. For a global install: npm install -g ${PACKAGE_NAME}@latest.`,
    };
  }
  const name = readPackageName(join(root, 'package.json'));
  if (name !== PACKAGE_NAME) {
    return {
      kind: 'unknown',
      detail: `${join(root, 'package.json')} is "${name ?? 'unreadable'}", not ${PACKAGE_NAME}; refusing to touch ${root}`,
    };
  }
  return { kind: 'checkout', root };
}

function defaultPackageName(path: string): string | null {
  try {
    const name = (JSON.parse(readFileSync(path, 'utf8')) as { name?: unknown }).name;
    return typeof name === 'string' ? name : null;
  } catch {
    return null;
  }
}

/** The version recorded in a package.json, or null. */
export function installedVersionAt(packageRoot: string): string | null {
  try {
    const raw = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
      version?: unknown;
    };
    return typeof raw.version === 'string' ? raw.version : null;
  } catch {
    return null;
  }
}

/**
 * Compare two semantic versions. Returns -1, 0 or 1, or null when either side
 * is not a version this can be sure about — which is reported as "cannot tell"
 * rather than resolved by guessing, because the guess would be "you are up to
 * date" and that is the wrong direction to be wrong in.
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 | null {
  const parse = (value: string): { parts: number[]; pre: string } | null => {
    const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
      value.trim(),
    );
    if (match === null) return null;
    return {
      parts: [Number(match[1]), Number(match[2]), Number(match[3])],
      pre: match[4] ?? '',
    };
  };
  const left = parse(a);
  const right = parse(b);
  if (left === null || right === null) return null;
  for (let i = 0; i < 3; i += 1) {
    const l = left.parts[i] as number;
    const r = right.parts[i] as number;
    if (l !== r) return l < r ? -1 : 1;
  }
  if (left.pre === right.pre) return 0;
  // A release outranks any prerelease of the same numbers (semver §11.3).
  if (left.pre === '') return 1;
  if (right.pre === '') return -1;
  return left.pre < right.pre ? -1 : 1;
}

// ------------------------------------------------------------------- helpers

interface Ctx {
  exec: NonNullable<UpgradeOptions['exec']>;
  /** `commands.git` from the config, so a machine with git somewhere odd works. */
  gitArgv: string[];
  root: string;
  steps: UpgradeStep[];
  notes: string[];
}

function push(ctx: Ctx, name: string, status: StepStatus, detail: string): void {
  ctx.steps.push({ name, status, detail });
}

async function git(ctx: Ctx, args: string[], timeoutMs = 120_000): Promise<RunResult> {
  return ctx.exec([...ctx.gitArgv, ...args], { cwd: ctx.root, timeoutMs });
}

/** Which package manager a checkout should be installed with. */
export async function choosePackageManager(
  exec: NonNullable<UpgradeOptions['exec']>,
  root: string,
  notes: string[],
): Promise<{ argv: string[]; install: string[]; label: string }> {
  if (existsSync(join(root, 'pnpm-lock.yaml'))) {
    const probe = await exec(['pnpm', '--version'], { cwd: root, timeoutMs: 30_000 });
    if (probe.ok) {
      return { argv: ['pnpm'], install: ['install', '--frozen-lockfile'], label: 'pnpm' };
    }
    notes.push(
      'this checkout has a pnpm lockfile but no runnable pnpm; falling back to npm, whose ' +
        'resolution may differ from the one the lockfile pins',
    );
  }
  return { argv: ['npm'], install: ['ci'], label: 'npm' };
}

/**
 * pnpm 11 turns an undeclared ignored build script into an install FAILURE, and
 * the message is easy to read as noise. Naming it exactly, with the fix, is the
 * difference between "the upgrade failed" and an upgrade nobody can unstick.
 */
export function ignoredBuildsAdvice(output: string): string | null {
  if (!/ERR_PNPM_IGNORED_BUILDS|Ignored build scripts/i.test(output)) return null;
  const named = /Ignored build scripts:\s*([^\n]+)/i.exec(output)?.[1]?.trim();
  return (
    `the package manager refused to finish because build scripts are undeclared${
      named === undefined ? '' : ` (${named})`
    }. That is a configuration answer, not a broken dependency: set them in ` +
    'pnpm-workspace.yaml under `allowBuilds:` (or run `pnpm approve-builds`), commit that, ' +
    'and upgrade again.'
  );
}

/** The newest mtime under a directory tree, or null when it does not exist. */
function newestMtime(dir: string, depth = 0): number | null {
  if (depth > 6 || !existsSync(dir)) return null;
  let newest: number | null = null;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  for (const entry of entries) {
    const path = join(dir, entry);
    let stat;
    try {
      stat = statSync(path);
    } catch {
      continue;
    }
    const candidate = stat.isDirectory() ? newestMtime(path, depth + 1) : stat.mtimeMs;
    if (candidate !== null && (newest === null || candidate > newest)) newest = candidate;
  }
  return newest;
}

/**
 * Publish a staged build as `dist`, undoing the move if the second rename fails.
 *
 * Two renames rather than one because renaming a directory ONTO a non-empty
 * directory is not a thing POSIX will do. The order is chosen so the only
 * failure that can happen with `dist` missing is the one this function
 * immediately reverses.
 */
export function publishStagedBuild(
  root: string,
  fs: {
    rename: typeof renameSync;
    rm: typeof rmSync;
    exists: typeof existsSync;
  } = { rename: renameSync, rm: rmSync, exists: existsSync },
): { ok: true; windowMs: number } | { ok: false; error: string; restored: boolean } {
  const dist = join(root, 'dist');
  const staging = join(root, STAGING_DIR);
  const retired = join(root, RETIRED_DIR);

  try {
    fs.rm(retired, { recursive: true, force: true });
  } catch {
    /* a leftover we could not clear is not a reason to refuse the upgrade */
  }

  const started = Date.now();
  let moved = false;
  try {
    if (fs.exists(dist)) {
      fs.rename(dist, retired);
      moved = true;
    }
    fs.rename(staging, dist);
  } catch (err) {
    let restored = false;
    if (moved) {
      try {
        fs.rename(retired, dist);
        restored = true;
      } catch {
        restored = false;
      }
    }
    return {
      ok: false,
      error: (err as Error).message.slice(0, 200),
      // Nothing was moved at all, so the installation is untouched — which
      // counts as restored for the purpose of telling an operator whether the
      // machine they are on still has a working rotorcc.
      restored: moved ? restored : true,
    };
  }
  const windowMs = Date.now() - started;

  try {
    fs.rm(retired, { recursive: true, force: true });
  } catch {
    /* the old build is now clutter; it is removed on the next upgrade */
  }
  return { ok: true, windowMs };
}

/** Parse `doctor --json` without importing the doctor this process was built with. */
export function summariseDoctor(
  stdout: string,
): { passed: number; warned: number; failed: number; failures: string[] } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const checks = parsed as Array<{ name?: unknown; status?: unknown }>;
  return {
    passed: checks.filter((c) => c.status === 'pass').length,
    warned: checks.filter((c) => c.status === 'warn').length,
    failed: checks.filter((c) => c.status === 'fail').length,
    failures: checks.filter((c) => c.status === 'fail').map((c) => String(c.name)),
  };
}

// -------------------------------------------------------------- entry point

export async function runUpgrade(
  options: UpgradeOptions,
): Promise<{ code: number; report: UpgradeReport }> {
  const exec = options.exec ?? ((argv, o) => run(argv, o ?? {}));
  const nodePath = options.nodePath ?? process.execPath;

  const report: UpgradeReport = {
    ok: true,
    applied: false,
    updateAvailable: false,
    action: options.check ? 'check' : 'apply',
    mode: 'unknown',
    repoRoot: null,
    packageRoot: null,
    branch: null,
    upstream: null,
    before: { commit: null, version: VERSION },
    after: { commit: null, version: null },
    latestPublished: null,
    steps: [],
    notes: [],
  };

  const shape: InstallShape =
    options.repoRoot === undefined
      ? detectInstall(options.binaryPath)
      : { kind: 'checkout', root: resolve(options.repoRoot) };

  if (shape.kind === 'unknown') {
    report.ok = false;
    report.steps.push({ name: 'install', status: 'refused', detail: shape.detail });
    return finish(options, report, UPGRADE_UNKNOWN);
  }

  const ctx: Ctx = {
    exec,
    gitArgv: options.config.commands.git,
    root: shape.kind === 'checkout' ? shape.root : shape.packageRoot,
    steps: report.steps,
    notes: report.notes,
  };

  if (shape.kind === 'package') {
    report.mode = 'package';
    report.packageRoot = shape.packageRoot;
    return upgradePackage(ctx, options, report, shape);
  }

  report.mode = 'checkout';
  report.repoRoot = shape.root;
  return upgradeCheckout(ctx, options, report, nodePath);
}

// ---------------------------------------------------------------- package

async function upgradePackage(
  ctx: Ctx,
  options: UpgradeOptions,
  report: UpgradeReport,
  shape: Extract<InstallShape, { kind: 'package' }>,
): Promise<{ code: number; report: UpgradeReport }> {
  push(ctx, 'install', 'ok', `global ${shape.manager} package at ${shape.packageRoot}`);

  const installed = installedVersionAt(shape.packageRoot) ?? VERSION;
  report.before.version = installed;

  const view = await ctx.exec([shape.manager, 'view', PACKAGE_NAME, 'version'], {
    timeoutMs: 120_000,
  });
  const latest = view.stdout.trim().split('\n').pop()?.trim() ?? '';
  if (!view.ok || latest === '') {
    report.ok = false;
    push(
      ctx,
      'registry',
      'failed',
      `could not ask the registry for the newest ${PACKAGE_NAME}: ` +
        `${(view.error ?? view.stderr).slice(0, 200)}`,
    );
    return finish(options, report, UPGRADE_UNKNOWN);
  }
  report.latestPublished = latest;

  const comparison = compareVersions(installed, latest);
  if (comparison === null) {
    report.ok = false;
    push(
      ctx,
      'compare',
      'failed',
      `cannot compare the installed version (${installed}) with the published one (${latest})`,
    );
    return finish(options, report, UPGRADE_UNKNOWN);
  }
  report.updateAvailable = comparison < 0;
  push(
    ctx,
    'compare',
    'ok',
    comparison < 0
      ? `${installed} installed, ${latest} published`
      : comparison === 0
        ? `already on ${installed}, the newest published`
        : `${installed} installed is NEWER than the published ${latest} (a local build?)`,
  );

  if (options.check) {
    await appendPackageBinaryCheck(ctx, report);
    if (!report.ok) return finish(options, report, UPGRADE_UNKNOWN);
    return finish(
      options,
      report,
      report.updateAvailable ? UPGRADE_AVAILABLE_OR_FAILED : UPGRADE_OK,
    );
  }

  const installArgv =
    shape.manager === 'pnpm'
      ? ['pnpm', 'add', '--global', `${PACKAGE_NAME}@latest`]
      : ['npm', 'install', '--global', `${PACKAGE_NAME}@latest`];

  if (!report.updateAvailable) {
    push(ctx, 'apply', 'skipped', 'nothing newer to install');
  } else if (options.dryRun) {
    push(ctx, 'apply', 'skipped', `DRY RUN — would run: ${installArgv.join(' ')}`);
  } else {
    if (!options.store.acquireLock('tick', 900)) {
      report.ok = false;
      push(
        ctx,
        'lock',
        'refused',
        'another rotorcc operation (a watcher tick, or a hook checkpointing) holds the lock. ' +
          'Nothing was changed; try again in a minute.',
      );
      return finish(options, report, UPGRADE_UNKNOWN);
    }
    try {
      const result = await ctx.exec(installArgv, { timeoutMs: 900_000 });
      if (!result.ok) {
        report.ok = false;
        const output = `${result.stderr}\n${result.error ?? ''}`;
        push(ctx, 'apply', 'failed', `${installArgv.join(' ')} failed: ${output.slice(0, 300)}`);
        if (/EACCES|permission denied/i.test(output)) {
          ctx.notes.push(
            'That is a permissions failure on the global prefix, not a rotorcc failure. Either ' +
              'point npm at a prefix you own (npm config set prefix ~/.local) or run the same ' +
              'command with sudo.',
          );
        }
        return finish(options, report, UPGRADE_AVAILABLE_OR_FAILED);
      }
      push(ctx, 'apply', 'ok', installArgv.join(' '));
      report.applied = true;
    } finally {
      options.store.releaseLock('tick');
    }
  }

  await appendPackageBinaryCheck(ctx, report);
  await appendDoctor(ctx, options, report, [PACKAGE_NAME]);
  return finish(options, report, report.ok ? UPGRADE_OK : UPGRADE_AVAILABLE_OR_FAILED);
}

/**
 * Ask the `rotorcc` the shell finds — by name, from PATH — what it now is.
 *
 * By name deliberately. A global reinstall replaces the package directory, so
 * the path this process was launched from may no longer be the one the operator
 * will run next. The question worth answering is "what does the next `rotorcc`
 * do", not "does the file I started from still exist".
 */
async function appendPackageBinaryCheck(ctx: Ctx, report: UpgradeReport): Promise<void> {
  const probe = await ctx.exec([PACKAGE_NAME, '--version'], { timeoutMs: 60_000 });
  const version = probe.stdout.trim().split('\n')[0] ?? '';
  if (!probe.ok || version === '') {
    report.ok = false;
    push(
      ctx,
      'binary',
      'failed',
      `"${PACKAGE_NAME}" on your PATH did not answer --version: ${(probe.error ?? probe.stderr).slice(0, 200)}`,
    );
    return;
  }
  report.after.version = version;
  push(ctx, 'binary', 'ok', `"${PACKAGE_NAME}" on your PATH reports ${version}`);
  if (
    report.latestPublished !== null &&
    report.applied &&
    compareVersions(version, report.latestPublished) === -1
  ) {
    report.ok = false;
    push(
      ctx,
      'binary',
      'failed',
      `the install reported success but PATH still resolves to ${version}, not ` +
        `${report.latestPublished}. Something else on your PATH is shadowing it — check ` +
        `"which -a ${PACKAGE_NAME}".`,
    );
  }
}

// --------------------------------------------------------------- checkout

async function upgradeCheckout(
  ctx: Ctx,
  options: UpgradeOptions,
  report: UpgradeReport,
  nodePath: string,
): Promise<{ code: number; report: UpgradeReport }> {
  push(ctx, 'checkout', 'ok', ctx.root);

  const status = await git(ctx, ['status', '--porcelain']);
  if (!status.ok) {
    report.ok = false;
    push(
      ctx,
      'clean tree',
      'failed',
      `git status failed: ${(status.error ?? status.stderr).slice(0, 160)}`,
    );
    return finish(options, report, UPGRADE_UNKNOWN);
  }
  const dirtyLines = status.stdout.split('\n').filter((line) => line.trim() !== '');
  if (dirtyLines.length > 0) {
    report.ok = false;
    push(
      ctx,
      'clean tree',
      'refused',
      `${dirtyLines.length} uncommitted change(s) — refusing to touch them:\n` +
        dirtyLines
          .slice(0, 10)
          .map((line) => `      ${line}`)
          .join('\n') +
        (dirtyLines.length > 10 ? `\n      … and ${dirtyLines.length - 10} more` : ''),
    );
    ctx.notes.push('Commit, stash or discard those, then run the upgrade again.');
    return finish(options, report, UPGRADE_UNKNOWN);
  }
  push(ctx, 'clean tree', 'ok', 'no uncommitted changes');

  const head = await git(ctx, ['rev-parse', '--short', 'HEAD']);
  report.before.commit = head.ok ? head.stdout.trim() : null;

  const branchResult = await git(ctx, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const branch = branchResult.ok ? branchResult.stdout.trim() : '';
  if (branch === '' || branch === 'HEAD') {
    report.ok = false;
    push(
      ctx,
      'branch',
      'refused',
      'HEAD is detached, so there is no branch to fast-forward. Check out a branch first.',
    );
    return finish(options, report, UPGRADE_UNKNOWN);
  }
  report.branch = branch;

  const upstreamResult = await git(ctx, [
    'rev-parse',
    '--abbrev-ref',
    '--symbolic-full-name',
    '@{upstream}',
  ]);
  if (!upstreamResult.ok || upstreamResult.stdout.trim() === '') {
    report.ok = false;
    push(
      ctx,
      'branch',
      'refused',
      `${branch} tracks no upstream branch, so there is nothing to fast-forward from.`,
    );
    ctx.notes.push(`git branch --set-upstream-to origin/${branch} ${branch}`);
    return finish(options, report, UPGRADE_UNKNOWN);
  }
  const upstream = upstreamResult.stdout.trim();
  report.upstream = upstream;
  push(ctx, 'branch', 'ok', `${branch} tracking ${upstream}`);

  const remote = upstream.includes('/') ? (upstream.split('/')[0] as string) : 'origin';
  const fetched = await git(ctx, ['fetch', '--prune', remote], 300_000);
  if (!fetched.ok) {
    report.ok = false;
    push(
      ctx,
      'fetch',
      'failed',
      `git fetch ${remote} failed: ${(fetched.error ?? fetched.stderr).slice(0, 200)}`,
    );
    return finish(options, report, UPGRADE_UNKNOWN);
  }
  push(ctx, 'fetch', 'ok', `fetched ${remote}`);

  const counted = await git(ctx, ['rev-list', '--left-right', '--count', `HEAD...${upstream}`]);
  const [aheadRaw, behindRaw] = counted.stdout.trim().split(/\s+/);
  const ahead = Number.parseInt(aheadRaw ?? '', 10);
  const behind = Number.parseInt(behindRaw ?? '', 10);
  if (!counted.ok || !Number.isInteger(ahead) || !Number.isInteger(behind)) {
    report.ok = false;
    push(ctx, 'compare', 'failed', 'could not count commits against the upstream branch');
    return finish(options, report, UPGRADE_UNKNOWN);
  }
  report.updateAvailable = behind > 0;

  if (ahead > 0 && behind > 0) {
    report.ok = false;
    push(
      ctx,
      'compare',
      'refused',
      `${branch} has DIVERGED from ${upstream}: ${ahead} local commit(s) it does not have, ` +
        `${behind} of its commits you do not. A fast-forward is impossible, and this command ` +
        'will not merge, rebase or reset on your behalf.',
    );
    ctx.notes.push(
      `Look at both sides: git log --oneline ${upstream}..HEAD  and  git log --oneline HEAD..${upstream}`,
    );
    return finish(options, report, UPGRADE_UNKNOWN);
  }

  push(
    ctx,
    'compare',
    'ok',
    behind > 0
      ? `${behind} new commit(s) on ${upstream}`
      : ahead > 0
        ? `already current; ${ahead} local commit(s) are not on ${remote} (nothing was pushed for you)`
        : `already at ${upstream}`,
  );

  if (options.check) {
    await appendCheckoutBinaryCheck(ctx, options, report, nodePath);
    if (!report.ok) return finish(options, report, UPGRADE_UNKNOWN);
    return finish(
      options,
      report,
      report.updateAvailable ? UPGRADE_AVAILABLE_OR_FAILED : UPGRADE_OK,
    );
  }

  if (options.dryRun) {
    push(
      ctx,
      'apply',
      'skipped',
      behind === 0
        ? 'DRY RUN — nothing to apply anyway'
        : `DRY RUN — would fast-forward ${behind} commit(s), reinstall and rebuild. Nothing was written.`,
    );
    await appendCheckoutBinaryCheck(ctx, options, report, nodePath);
    return finish(options, report, report.ok ? UPGRADE_OK : UPGRADE_UNKNOWN);
  }

  // 900s: an install on a cold cache plus a build is minutes, not seconds, and a
  // lock that expired mid-build would let a tick run against a staged tree.
  if (!options.store.acquireLock('tick', 900)) {
    report.ok = false;
    push(
      ctx,
      'lock',
      'refused',
      'another rotorcc operation (a watcher tick, or a hook checkpointing) holds the lock. ' +
        'Nothing was changed; try again in a minute.',
    );
    return finish(options, report, UPGRADE_UNKNOWN);
  }

  try {
    if (behind > 0) {
      const ff = await git(ctx, ['merge', '--ff-only', upstream], 120_000);
      if (!ff.ok) {
        report.ok = false;
        push(ctx, 'fast-forward', 'failed', (ff.error ?? ff.stderr).slice(0, 200));
        return finish(options, report, UPGRADE_AVAILABLE_OR_FAILED);
      }
      const now = await git(ctx, ['rev-parse', '--short', 'HEAD']);
      push(
        ctx,
        'fast-forward',
        'ok',
        `${report.before.commit ?? '?'} → ${now.ok ? now.stdout.trim() : '?'}`,
      );
    } else {
      push(ctx, 'fast-forward', 'skipped', 'already current');
    }

    const pm = await choosePackageManager(ctx.exec, ctx.root, ctx.notes);
    const installed = await ctx.exec([...pm.argv, ...pm.install], {
      cwd: ctx.root,
      timeoutMs: 900_000,
    });
    const installOutput = `${installed.stdout}\n${installed.stderr}\n${installed.error ?? ''}`;
    const buildsAdvice = ignoredBuildsAdvice(installOutput);
    if (!installed.ok) {
      report.ok = false;
      push(
        ctx,
        'dependencies',
        'failed',
        buildsAdvice ??
          `${pm.label} ${pm.install.join(' ')} failed: ${(installed.error ?? installed.stderr).slice(0, 300)}`,
      );
      ctx.notes.push('dist/ was not touched: the binary you are running is exactly as it was.');
      return finish(options, report, UPGRADE_AVAILABLE_OR_FAILED);
    }
    push(ctx, 'dependencies', 'ok', `${pm.label} ${pm.install.join(' ')}`);
    if (buildsAdvice !== null) {
      // Exit code 0 with the warning still present: worth surfacing, not worth
      // failing over. Silence here is how it becomes a mystery later.
      ctx.notes.push(`note from ${pm.label}: ${buildsAdvice}`);
    }

    const staging = join(ctx.root, STAGING_DIR);
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
    const built = await ctx.exec(
      [...pm.argv, 'exec', 'tsc', '-p', 'tsconfig.build.json', '--outDir', staging],
      { cwd: ctx.root, timeoutMs: 900_000 },
    );
    const stagedEntry = join(staging, 'cli.js');
    if (!built.ok || !existsSync(stagedEntry)) {
      report.ok = false;
      push(
        ctx,
        'build',
        'failed',
        (built.stdout || built.stderr || built.error || 'no output').slice(0, 400),
      );
      ctx.notes.push(
        'The build was staged, so dist/ was never opened — this machine still runs the previous build.',
      );
      rmSync(staging, { recursive: true, force: true });
      return finish(options, report, UPGRADE_AVAILABLE_OR_FAILED);
    }

    // Prove the staged build STARTS before it becomes the live one. A tsc that
    // exits 0 having emitted something which throws on import is rare, and it is
    // exactly the failure that would leave a machine with no working rotorcc.
    const probe = await ctx.exec([nodePath, stagedEntry, '--version'], {
      cwd: ctx.root,
      timeoutMs: 60_000,
    });
    const stagedVersion = probe.stdout.trim().split('\n')[0] ?? '';
    if (!probe.ok || stagedVersion === '') {
      report.ok = false;
      push(
        ctx,
        'build',
        'failed',
        `the freshly built CLI did not run: ${(probe.error ?? probe.stderr).slice(0, 200)}`,
      );
      ctx.notes.push('dist/ was never touched; this machine still runs the previous build.');
      rmSync(staging, { recursive: true, force: true });
      return finish(options, report, UPGRADE_AVAILABLE_OR_FAILED);
    }
    push(ctx, 'build', 'ok', `staged build runs and reports ${stagedVersion}`);

    const published = publishStagedBuild(ctx.root);
    if (!published.ok) {
      report.ok = false;
      push(
        ctx,
        'publish',
        'failed',
        `could not put the new build in place: ${published.error}. ` +
          (published.restored
            ? 'The previous dist/ was restored and this machine still runs it.'
            : `dist/ IS MISSING — restore it now: mv ${join(ctx.root, RETIRED_DIR)} ${join(ctx.root, 'dist')}`),
      );
      return finish(options, report, UPGRADE_AVAILABLE_OR_FAILED);
    }
    push(
      ctx,
      'publish',
      'ok',
      `swapped in by rename; dist/ was absent for ${published.windowMs}ms`,
    );
    report.applied = behind > 0;
  } finally {
    options.store.releaseLock('tick');
  }

  await appendCheckoutBinaryCheck(ctx, options, report, nodePath);
  const afterCommit = await git(ctx, ['rev-parse', '--short', 'HEAD']);
  report.after.commit = afterCommit.ok ? afterCommit.stdout.trim() : null;
  await appendDoctor(ctx, options, report, [nodePath, join(ctx.root, 'dist', 'cli.js')]);

  return finish(options, report, report.ok ? UPGRADE_OK : UPGRADE_AVAILABLE_OR_FAILED);
}

/**
 * Check that the binary the operator runs still points at this checkout's build.
 *
 * A checkout install is a symlink pointing at `dist/cli.js`. A rename that went
 * somewhere unexpected, a second checkout, or an `npm install -g` that shadowed
 * the link all end the same way: the operator upgrades one copy and runs
 * another.
 */
async function appendCheckoutBinaryCheck(
  ctx: Ctx,
  options: UpgradeOptions,
  report: UpgradeReport,
  nodePath: string,
): Promise<void> {
  const expected = join(ctx.root, 'dist', 'cli.js');
  if (!existsSync(expected)) {
    report.ok = false;
    push(
      ctx,
      'binary',
      'failed',
      `${expected} does not exist — this checkout has never been built`,
    );
    return;
  }
  if (options.repoRoot === undefined && resolve(options.binaryPath) !== resolve(expected)) {
    report.ok = false;
    push(
      ctx,
      'binary',
      'refused',
      `the rotorcc you ran resolves to ${options.binaryPath}, not ${expected}. That is a ` +
        'different installation; upgrading this checkout will not change the one on your PATH.',
    );
    return;
  }

  const distMtime = newestMtime(join(ctx.root, 'dist'));
  const srcMtime = newestMtime(join(ctx.root, 'src'));
  if (distMtime !== null && srcMtime !== null && srcMtime > distMtime) {
    ctx.notes.push(
      'dist/ is older than the newest file in src/ — this checkout has source changes that were ' +
        'never built. Run "rotorcc upgrade" (or the build) again.',
    );
  }

  const probe = await ctx.exec([nodePath, expected, '--version'], { timeoutMs: 60_000 });
  const version = probe.stdout.trim().split('\n')[0] ?? '';
  if (!probe.ok || version === '') {
    report.ok = false;
    push(
      ctx,
      'binary',
      'failed',
      `${expected} did not run: ${(probe.error ?? probe.stderr).slice(0, 200)}`,
    );
    return;
  }
  report.after.version = version;
  push(ctx, 'binary', 'ok', `${expected} runs and reports ${version}`);
}

/**
 * Run doctor through the NEW binary, not in this process.
 *
 * This process is still running the code it started with, so an in-process
 * check would report on the build that was just replaced — precisely the
 * stale-artifact claim this command exists to make impossible.
 */
async function appendDoctor(
  ctx: Ctx,
  options: UpgradeOptions,
  report: UpgradeReport,
  argv: string[],
): Promise<void> {
  const doctorArgs = [...argv, 'doctor', '--json'];
  if (options.configPath !== undefined) doctorArgs.push('--config', options.configPath);
  const doctor = await ctx.exec(doctorArgs, { timeoutMs: 180_000 });
  const summary = summariseDoctor(doctor.stdout);
  if (summary === null) {
    report.ok = false;
    push(
      ctx,
      'doctor',
      'failed',
      `doctor produced no readable report: ${(doctor.error ?? doctor.stderr).slice(0, 200)}`,
    );
    return;
  }
  push(
    ctx,
    'doctor',
    summary.failed > 0 ? 'failed' : 'ok',
    `${summary.passed} passed, ${summary.warned} warning(s), ${summary.failed} failure(s)` +
      (summary.failures.length === 0 ? '' : `: ${summary.failures.join('; ')}`),
  );
  if (summary.failed > 0) report.ok = false;
}

// ------------------------------------------------------------------ output

function finish(
  options: UpgradeOptions,
  report: UpgradeReport,
  code: number,
): { code: number; report: UpgradeReport } {
  if (options.json) options.out(JSON.stringify(report, null, 2));
  else options.out(renderUpgrade(report));
  return { code, report };
}

export function renderUpgrade(report: UpgradeReport): string {
  const symbol: Record<StepStatus, string> = {
    ok: 'ok   ',
    skipped: '--   ',
    refused: 'STOP ',
    failed: 'FAIL ',
  };
  const lines = [
    `rotorcc upgrade${report.action === 'check' ? ' --check' : ''} — ${report.mode} install`,
    '',
  ];
  for (const step of report.steps) {
    lines.push(`  ${symbol[step.status]} ${step.name.padEnd(14)} ${step.detail}`);
  }
  lines.push('');

  const label = (version: string | null, commit: string | null): string =>
    commit === null ? (version ?? '?') : `${version ?? '?'} (${commit})`;
  const from = label(report.before.version, report.before.commit);
  const to = label(
    report.after.version ?? report.before.version,
    report.after.commit ?? report.before.commit,
  );
  lines.push(report.applied ? `  ${from}  →  ${to}` : `  ${from} — unchanged`);
  for (const note of report.notes) lines.push(`  note: ${note}`);
  lines.push('');
  lines.push(
    report.action === 'check'
      ? report.updateAvailable
        ? '  An upgrade is available. Run "rotorcc upgrade" to apply it.'
        : report.ok
          ? '  Already current.'
          : '  Could not tell — see above.'
      : report.ok
        ? report.applied
          ? '  Upgraded.'
          : '  Already current; nothing was changed.'
        : '  NOT upgraded. Nothing was applied — see above.',
  );
  lines.push('');
  return lines.join('\n');
}
