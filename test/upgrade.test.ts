/**
 * `rotorcc upgrade`.
 *
 * Two things are worth testing here and they are not the happy path:
 *
 *   1. **Every refusal.** A dirty tree, a diverged branch, a detached HEAD, a
 *      branch tracking nothing, a held lock. Each one must stop before anything
 *      is written, and the report must say which.
 *   2. **A failed build cannot damage the live install.** The build is staged
 *      and published by rename, so `dist/` is either the old one or the new one
 *      and never a mixture — including when the rename itself fails.
 *
 * No test here spawns a process or touches the network: every subprocess goes
 * through an injected `exec`, and the PATH lookup through an injected resolver,
 * so a real rotorcc on the runner's PATH cannot change a result.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  RETIRED_DIR,
  STAGING_DIR,
  UPGRADE_AVAILABLE_OR_FAILED,
  UPGRADE_OK,
  UPGRADE_UNKNOWN,
  type UpgradeReport,
  compareVersions,
  detectInstall,
  ignoredBuildsAdvice,
  publishStagedBuild,
  resolveOnPath,
  runUpgrade,
  summariseDoctor,
} from '../src/commands/upgrade.js';
import { Store } from '../src/core/state.js';
import type { RunResult } from '../src/core/proc.js';
import { cleanup, tempDir, testConfig } from './helpers.js';

const dirs: string[] = [];

afterEach(() => cleanup(...dirs.splice(0)));

function fixture(): { root: string; state: string } {
  const root = tempDir('rotorcc-upgrade-');
  dirs.push(root);
  mkdirSync(join(root, '.git'), { recursive: true });
  mkdirSync(join(root, 'dist'), { recursive: true });
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'rotorcc', version: '0.1.0' }));
  writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
  writeFileSync(join(root, 'dist', 'cli.js'), '#!/usr/bin/env node\n// old build\n');
  const state = join(root, 'state');
  mkdirSync(state, { recursive: true });
  return { root, state };
}

function ok(stdout = ''): RunResult {
  return { ok: true, code: 0, stdout, stderr: '' };
}
function fail(stderr: string, code = 1): RunResult {
  return { ok: false, code, stdout: '', stderr, error: stderr };
}

/**
 * A fake subprocess table. Keys are matched as a prefix of the joined argv, so
 * a test states only the commands it cares about and anything unexpected fails
 * loudly rather than silently succeeding.
 */
function execFrom(table: Array<[string, RunResult | ((argv: string[]) => RunResult)]>): {
  exec: (argv: string[], options?: { cwd?: string; timeoutMs?: number }) => Promise<RunResult>;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    exec: (argv) => {
      const joined = argv.join(' ');
      calls.push(joined);
      for (const [prefix, response] of table) {
        if (joined.includes(prefix)) {
          return Promise.resolve(typeof response === 'function' ? response(argv) : response);
        }
      }
      return Promise.resolve(fail(`no fake for: ${joined}`, 127));
    },
  };
}

const NO_ROTORCC_ON_PATH = (): Array<{ entry: string; target: string }> => [];

function baseOptions(root: string, state: string, overrides: Record<string, unknown> = {}) {
  return {
    binaryPath: join(root, 'dist', 'cli.js'),
    repoRoot: root,
    check: false,
    dryRun: false,
    json: false,
    config: testConfig(),
    store: new Store(state),
    out: () => {},
    pathResolver: NO_ROTORCC_ON_PATH,
    nodePath: 'node',
    ...overrides,
  };
}

/** The git conversation of a clean checkout that is `behind` commits behind. */
function gitTable(behind: number, ahead = 0): Array<[string, RunResult]> {
  return [
    ['git status --porcelain', ok('')],
    ['git rev-parse --short HEAD', ok('aaaaaaa\n')],
    ['git rev-parse --abbrev-ref --symbolic-full-name @{upstream}', ok('origin/main\n')],
    ['git rev-parse --abbrev-ref HEAD', ok('main\n')],
    ['git fetch --prune origin', ok('')],
    ['git rev-list --left-right --count', ok(`${ahead}\t${behind}\n`)],
    ['git merge --ff-only origin/main', ok('Fast-forward\n')],
  ];
}

const DOCTOR_GREEN = ok(JSON.stringify([{ name: 'platform', status: 'pass', detail: 'linux' }]));

describe('detectInstall', () => {
  it('recognises a global npm package install', () => {
    const shape = detectInstall('/usr/lib/node_modules/rotorcc/dist/cli.js');
    expect(shape.kind).toBe('package');
    if (shape.kind === 'package') {
      expect(shape.packageRoot).toBe('/usr/lib/node_modules/rotorcc');
      expect(shape.manager).toBe('npm');
    }
  });

  it("recognises pnpm's global store", () => {
    const shape = detectInstall(
      '/home/u/.local/share/pnpm/global/5/node_modules/rotorcc/dist/cli.js',
    );
    expect(shape.kind).toBe('package');
    if (shape.kind === 'package') expect(shape.manager).toBe('pnpm');
  });

  it('recognises a git checkout', () => {
    const shape = detectInstall(
      '/home/u/rotorcc/dist/cli.js',
      (path) => path === '/home/u/rotorcc/.git',
      () => 'rotorcc',
    );
    expect(shape).toEqual({ kind: 'checkout', root: '/home/u/rotorcc' });
  });

  it('prefers the package shape when a checkout somehow sits inside node_modules', () => {
    // Fetching and rebuilding somebody's vendored copy would be a surprising
    // thing for a command that was asked to update a package.
    const shape = detectInstall(
      '/srv/app/node_modules/rotorcc/dist/cli.js',
      () => true,
      () => 'rotorcc',
    );
    expect(shape.kind).toBe('package');
  });

  it('refuses a directory with no .git and no node_modules, rather than guessing', () => {
    const shape = detectInstall(
      '/opt/rotorcc/dist/cli.js',
      () => false,
      () => 'rotorcc',
    );
    expect(shape.kind).toBe('unknown');
    if (shape.kind === 'unknown') expect(shape.detail).toContain('npm install -g rotorcc@latest');
  });

  it('refuses a checkout whose package.json is some other project', () => {
    const shape = detectInstall(
      '/home/u/thing/dist/cli.js',
      () => true,
      () => 'not-rotorcc',
    );
    expect(shape.kind).toBe('unknown');
    if (shape.kind === 'unknown') expect(shape.detail).toContain('not-rotorcc');
  });

  it('refuses a binary that is not a dist/cli.js at all', () => {
    const shape = detectInstall(
      '/usr/local/bin/rotorcc',
      () => true,
      () => 'rotorcc',
    );
    expect(shape.kind).toBe('unknown');
  });
});

describe('compareVersions', () => {
  it('orders releases', () => {
    expect(compareVersions('0.1.0', '0.2.0')).toBe(-1);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('1.10.0', '1.9.0')).toBe(1);
    expect(compareVersions('v1.2.3', '1.2.3')).toBe(0);
  });

  it('ranks a release above a prerelease of the same numbers', () => {
    expect(compareVersions('1.0.0', '1.0.0-beta.1')).toBe(1);
    expect(compareVersions('1.0.0-beta.1', '1.0.0')).toBe(-1);
  });

  it('returns null rather than guessing on a version it cannot parse', () => {
    // The guess would be "you are up to date", which is the wrong direction to
    // be wrong in for a command whose job is to deliver fixes.
    expect(compareVersions('latest', '1.0.0')).toBeNull();
    expect(compareVersions('1.0', '1.0.0')).toBeNull();
    expect(compareVersions('', '')).toBeNull();
  });
});

describe('ignoredBuildsAdvice', () => {
  it('names the packages and the fix when pnpm refuses over build scripts', () => {
    const advice = ignoredBuildsAdvice(
      '[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: esbuild@0.21.5.\nRun "pnpm approve-builds"',
    );
    expect(advice).toContain('esbuild@0.21.5');
    expect(advice).toContain('allowBuilds');
  });

  it('says nothing about ordinary output', () => {
    expect(ignoredBuildsAdvice('Already up to date\nDone in 4.5s')).toBeNull();
  });
});

describe('publishStagedBuild', () => {
  it('swaps the staged build in and removes the outgoing one', () => {
    const { root } = fixture();
    mkdirSync(join(root, STAGING_DIR), { recursive: true });
    writeFileSync(join(root, STAGING_DIR, 'cli.js'), '// new build\n');

    const result = publishStagedBuild(root);
    expect(result.ok).toBe(true);
    expect(readFileSync(join(root, 'dist', 'cli.js'), 'utf8')).toContain('new build');
    expect(existsSync(join(root, STAGING_DIR))).toBe(false);
    expect(existsSync(join(root, RETIRED_DIR))).toBe(false);
  });

  it('puts the old dist back when the second rename fails', () => {
    const { root } = fixture();
    mkdirSync(join(root, STAGING_DIR), { recursive: true });
    writeFileSync(join(root, STAGING_DIR, 'cli.js'), '// new build\n');

    let renames = 0;
    const result = publishStagedBuild(root, {
      exists: existsSync,
      rm: rmSync,
      rename: ((from: string, to: string) => {
        renames += 1;
        // The dangerous instant: dist has been moved away and the replacement
        // will not go in. Anything less than an immediate restore leaves the
        // machine with no rotorcc at all.
        if (renames === 2) throw new Error('EXDEV: simulated');
        renameSync(from, to);
      }) as typeof renameSync,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.restored).toBe(true);
      expect(result.error).toContain('EXDEV');
    }
    expect(existsSync(join(root, 'dist', 'cli.js'))).toBe(true);
    expect(readFileSync(join(root, 'dist', 'cli.js'), 'utf8')).toContain('old build');
  });

  it('reports honestly when the restore also fails', () => {
    const { root } = fixture();
    mkdirSync(join(root, STAGING_DIR), { recursive: true });

    const result = publishStagedBuild(root, {
      exists: existsSync,
      rm: rmSync,
      rename: ((from: string, to: string) => {
        if (String(to).includes(RETIRED_DIR)) {
          renameSync(from, to);
          return;
        }
        throw new Error('everything fails');
      }) as typeof renameSync,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.restored).toBe(false);
  });

  it('works when there is no dist to replace', () => {
    const { root } = fixture();
    rmSync(join(root, 'dist'), { recursive: true, force: true });
    mkdirSync(join(root, STAGING_DIR), { recursive: true });
    writeFileSync(join(root, STAGING_DIR, 'cli.js'), '// first build\n');

    const result = publishStagedBuild(root);
    expect(result.ok).toBe(true);
    expect(existsSync(join(root, 'dist', 'cli.js'))).toBe(true);
  });
});

describe('summariseDoctor', () => {
  it('counts a report', () => {
    const summary = summariseDoctor(
      JSON.stringify([
        { name: 'a', status: 'pass' },
        { name: 'b', status: 'warn' },
        { name: 'c', status: 'fail' },
      ]),
    );
    expect(summary).toEqual({ passed: 1, warned: 1, failed: 1, failures: ['c'] });
  });

  it('returns null for output that is not a doctor report', () => {
    expect(summariseDoctor('rotorcc: something exploded')).toBeNull();
    expect(summariseDoctor('{"not":"an array"}')).toBeNull();
  });
});

describe('resolveOnPath', () => {
  it('finds every copy on PATH, in PATH order', () => {
    const first = tempDir('rotorcc-path-a-');
    const second = tempDir('rotorcc-path-b-');
    dirs.push(first, second);
    writeFileSync(join(first, 'rotorcc'), '');
    writeFileSync(join(second, 'rotorcc'), '');

    const found = resolveOnPath('rotorcc', { PATH: `${first}:${second}` }, false);
    expect(found).toHaveLength(2);
    expect(found[0]?.entry).toBe(join(first, 'rotorcc'));
  });

  it('is empty when nothing matches', () => {
    const dir = tempDir('rotorcc-path-empty-');
    dirs.push(dir);
    expect(resolveOnPath('rotorcc', { PATH: dir }, false)).toEqual([]);
  });
});

describe('runUpgrade — refusals', () => {
  it('refuses a dirty tree and names the files', async () => {
    const { root, state } = fixture();
    const { exec } = execFrom([['git status --porcelain', ok(' M src/cli.ts\n?? scratch.md\n')]]);
    const lines: string[] = [];

    const { code, report } = await runUpgrade(
      baseOptions(root, state, { exec, out: (l: string) => lines.push(l) }) as never,
    );

    expect(code).toBe(UPGRADE_UNKNOWN);
    expect(report.ok).toBe(false);
    expect(stepStatus(report, 'clean tree')).toBe('refused');
    expect(lines.join('\n')).toContain('src/cli.ts');
    expect(lines.join('\n')).toContain('scratch.md');
  });

  it('refuses a diverged branch without merging, rebasing or resetting', async () => {
    const { root, state } = fixture();
    const { exec, calls } = execFrom(gitTable(3, 2));

    const { code, report } = await runUpgrade(baseOptions(root, state, { exec }) as never);

    expect(code).toBe(UPGRADE_UNKNOWN);
    expect(stepStatus(report, 'compare')).toBe('refused');
    expect(calls.some((c) => c.includes('merge'))).toBe(false);
    expect(calls.some((c) => c.includes('rebase'))).toBe(false);
    expect(calls.some((c) => c.includes('reset'))).toBe(false);
  });

  it('refuses a detached HEAD', async () => {
    const { root, state } = fixture();
    const { exec } = execFrom([
      ['git status --porcelain', ok('')],
      ['git rev-parse --short HEAD', ok('aaaaaaa\n')],
      ['git rev-parse --abbrev-ref HEAD', ok('HEAD\n')],
    ]);

    const { code, report } = await runUpgrade(baseOptions(root, state, { exec }) as never);
    expect(code).toBe(UPGRADE_UNKNOWN);
    expect(stepStatus(report, 'branch')).toBe('refused');
  });

  it('refuses a branch that tracks nothing', async () => {
    const { root, state } = fixture();
    const { exec } = execFrom([
      ['git status --porcelain', ok('')],
      ['git rev-parse --short HEAD', ok('aaaaaaa\n')],
      ['git rev-parse --abbrev-ref --symbolic-full-name @{upstream}', fail('no upstream')],
      ['git rev-parse --abbrev-ref HEAD', ok('work/thing\n')],
    ]);

    const { code, report } = await runUpgrade(baseOptions(root, state, { exec }) as never);
    expect(code).toBe(UPGRADE_UNKNOWN);
    expect(report.notes.join(' ')).toContain('--set-upstream-to');
  });

  it('refuses while another rotorcc operation holds the tick lock', async () => {
    const { root, state } = fixture();
    const store = new Store(state);
    expect(store.acquireLock('tick', 600)).toBe(true);

    const { exec, calls } = execFrom(gitTable(2));
    const { code, report } = await runUpgrade(baseOptions(root, state, { exec, store }) as never);

    expect(code).toBe(UPGRADE_UNKNOWN);
    expect(stepStatus(report, 'lock')).toBe('refused');
    // Nothing was fast-forwarded: the lock is taken before any mutation.
    expect(calls.some((c) => c.includes('merge'))).toBe(false);
    store.releaseLock('tick');
  });

  it('refuses an installation it cannot identify', async () => {
    const { root, state } = fixture();
    rmSync(join(root, '.git'), { recursive: true, force: true });
    const { code, report } = await runUpgrade(
      baseOptions(root, state, { repoRoot: undefined }) as never,
    );
    expect(code).toBe(UPGRADE_UNKNOWN);
    expect(report.mode).toBe('unknown');
  });
});

describe('runUpgrade — checkout mode', () => {
  it('--check reports an available upgrade as 1 and changes nothing', async () => {
    const { root, state } = fixture();
    const { exec, calls } = execFrom([
      ...gitTable(4),
      ['node ' + join(root, 'dist', 'cli.js') + ' --version', ok('0.1.0\n')],
    ]);

    const { code, report } = await runUpgrade(
      baseOptions(root, state, { exec, check: true }) as never,
    );

    expect(code).toBe(UPGRADE_AVAILABLE_OR_FAILED);
    expect(report.updateAvailable).toBe(true);
    expect(report.applied).toBe(false);
    expect(calls.some((c) => c.includes('merge'))).toBe(false);
    expect(calls.some((c) => c.includes('install'))).toBe(false);
  });

  it('--check reports "already current" as 0', async () => {
    const { root, state } = fixture();
    const { exec } = execFrom([
      ...gitTable(0),
      ['node ' + join(root, 'dist', 'cli.js') + ' --version', ok('0.1.0\n')],
    ]);

    const { code, report } = await runUpgrade(
      baseOptions(root, state, { exec, check: true }) as never,
    );
    expect(code).toBe(UPGRADE_OK);
    expect(report.updateAvailable).toBe(false);
  });

  it('fast-forwards, reinstalls, rebuilds, publishes and verifies', async () => {
    const { root, state } = fixture();
    const staged = join(root, STAGING_DIR);
    const { exec, calls } = execFrom([
      ...gitTable(3),
      ['pnpm --version', ok('11.0.0\n')],
      ['pnpm install --frozen-lockfile', ok('Already up to date\n')],
      [
        'pnpm exec tsc',
        () => {
          // Stand in for the compiler: emit the one file the publish step needs.
          mkdirSync(staged, { recursive: true });
          writeFileSync(join(staged, 'cli.js'), '#!/usr/bin/env node\n// fresh build\n');
          return ok('');
        },
      ],
      [`node ${join(staged, 'cli.js')} --version`, ok('0.2.0\n')],
      [`node ${join(root, 'dist', 'cli.js')} --version`, ok('0.2.0\n')],
      ['doctor --json', DOCTOR_GREEN],
    ]);

    const { code, report } = await runUpgrade(baseOptions(root, state, { exec }) as never);

    expect(code).toBe(UPGRADE_OK);
    expect(report.ok).toBe(true);
    expect(report.applied).toBe(true);
    expect(report.mode).toBe('checkout');
    expect(readFileSync(join(root, 'dist', 'cli.js'), 'utf8')).toContain('fresh build');
    expect(existsSync(staged)).toBe(false);
    // The verification ran through the NEW binary, not in this process.
    expect(calls.some((c) => c.includes('doctor --json'))).toBe(true);
    expect(stepStatus(report, 'doctor')).toBe('ok');
    // And the lock it took is released again.
    expect(new Store(state).acquireLock('tick', 600)).toBe(true);
  });

  it('leaves the live dist untouched when the build fails', async () => {
    const { root, state } = fixture();
    const { exec } = execFrom([
      ...gitTable(1),
      ['pnpm --version', ok('11.0.0\n')],
      ['pnpm install --frozen-lockfile', ok('')],
      ['pnpm exec tsc', fail("src/cli.ts(4,1): error TS2304: Cannot find name 'nope'.")],
    ]);

    const { code, report } = await runUpgrade(baseOptions(root, state, { exec }) as never);

    expect(code).toBe(UPGRADE_AVAILABLE_OR_FAILED);
    expect(stepStatus(report, 'build')).toBe('failed');
    expect(readFileSync(join(root, 'dist', 'cli.js'), 'utf8')).toContain('old build');
    expect(existsSync(join(root, STAGING_DIR))).toBe(false);
    expect(report.notes.join(' ')).toContain('previous build');
  });

  it('leaves the live dist untouched when the fresh build will not start', async () => {
    const { root, state } = fixture();
    const staged = join(root, STAGING_DIR);
    const { exec } = execFrom([
      ...gitTable(1),
      ['pnpm --version', ok('11.0.0\n')],
      ['pnpm install --frozen-lockfile', ok('')],
      [
        'pnpm exec tsc',
        () => {
          mkdirSync(staged, { recursive: true });
          writeFileSync(join(staged, 'cli.js'), 'throw new Error("boom")');
          return ok('');
        },
      ],
      [`node ${join(staged, 'cli.js')} --version`, fail('Error: boom')],
    ]);

    const { code, report } = await runUpgrade(baseOptions(root, state, { exec }) as never);

    expect(code).toBe(UPGRADE_AVAILABLE_OR_FAILED);
    expect(stepStatus(report, 'build')).toBe('failed');
    expect(readFileSync(join(root, 'dist', 'cli.js'), 'utf8')).toContain('old build');
  });

  it("names pnpm's undeclared-build-script refusal instead of reporting it as noise", async () => {
    const { root, state } = fixture();
    const { exec } = execFrom([
      ...gitTable(1),
      ['pnpm --version', ok('11.0.0\n')],
      [
        'pnpm install --frozen-lockfile',
        fail('[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: esbuild@0.21.5.'),
      ],
    ]);

    const { report } = await runUpgrade(baseOptions(root, state, { exec }) as never);
    expect(stepStatus(report, 'dependencies')).toBe('failed');
    expect(stepDetail(report, 'dependencies')).toContain('esbuild@0.21.5');
    expect(stepDetail(report, 'dependencies')).toContain('allowBuilds');
    expect(report.notes.join(' ')).toContain('dist/ was not touched');
  });

  it('surfaces an ignored-builds warning that did NOT fail the install, as a note', async () => {
    const { root, state } = fixture();
    const staged = join(root, STAGING_DIR);
    const { exec } = execFrom([
      ...gitTable(1),
      ['pnpm --version', ok('11.0.0\n')],
      [
        'pnpm install --frozen-lockfile',
        { ok: true, code: 0, stdout: '', stderr: 'Ignored build scripts: esbuild@0.21.5.' },
      ],
      [
        'pnpm exec tsc',
        () => {
          mkdirSync(staged, { recursive: true });
          writeFileSync(join(staged, 'cli.js'), '// fresh\n');
          return ok('');
        },
      ],
      [`node ${join(staged, 'cli.js')} --version`, ok('0.2.0\n')],
      [`node ${join(root, 'dist', 'cli.js')} --version`, ok('0.2.0\n')],
      ['doctor --json', DOCTOR_GREEN],
    ]);

    const { code, report } = await runUpgrade(baseOptions(root, state, { exec }) as never);
    expect(code).toBe(UPGRADE_OK);
    expect(report.notes.join(' ')).toContain('esbuild@0.21.5');
  });

  it('fails when the new build is in place but doctor is not green', async () => {
    const { root, state } = fixture();
    const staged = join(root, STAGING_DIR);
    const { exec } = execFrom([
      ...gitTable(1),
      ['pnpm --version', ok('11.0.0\n')],
      ['pnpm install --frozen-lockfile', ok('')],
      [
        'pnpm exec tsc',
        () => {
          mkdirSync(staged, { recursive: true });
          writeFileSync(join(staged, 'cli.js'), '// fresh\n');
          return ok('');
        },
      ],
      [`node ${join(staged, 'cli.js')} --version`, ok('0.2.0\n')],
      [`node ${join(root, 'dist', 'cli.js')} --version`, ok('0.2.0\n')],
      [
        'doctor --json',
        ok(JSON.stringify([{ name: 'accounts', status: 'fail', detail: 'no accounts' }])),
      ],
    ]);

    const { code, report } = await runUpgrade(baseOptions(root, state, { exec }) as never);
    expect(code).toBe(UPGRADE_AVAILABLE_OR_FAILED);
    expect(stepDetail(report, 'doctor')).toContain('accounts');
  });

  it('refuses when the rotorcc on PATH is a different installation', async () => {
    const { root, state } = fixture();
    const { exec } = execFrom([
      ...gitTable(0),
      [`node ${join(root, 'dist', 'cli.js')} --version`, ok('0.1.0\n')],
    ]);

    const { code, report } = await runUpgrade(
      baseOptions(root, state, {
        exec,
        check: true,
        pathResolver: () => [
          { entry: '/usr/local/bin/rotorcc', target: '/usr/lib/node_modules/rotorcc/dist/cli.js' },
        ],
      }) as never,
    );

    expect(code).toBe(UPGRADE_UNKNOWN);
    expect(stepStatus(report, 'binary')).toBe('refused');
    expect(stepDetail(report, 'binary')).toContain('does not change what your shell runs');
  });

  it('a dry run writes nothing at all', async () => {
    const { root, state } = fixture();
    const { exec, calls } = execFrom([
      ...gitTable(5),
      [`node ${join(root, 'dist', 'cli.js')} --version`, ok('0.1.0\n')],
    ]);

    const { code, report } = await runUpgrade(
      baseOptions(root, state, { exec, dryRun: true }) as never,
    );

    expect(code).toBe(UPGRADE_OK);
    expect(report.applied).toBe(false);
    expect(calls.some((c) => c.includes('merge'))).toBe(false);
    expect(calls.some((c) => c.includes('install'))).toBe(false);
    expect(readFileSync(join(root, 'dist', 'cli.js'), 'utf8')).toContain('old build');
    expect(readdirSync(root)).not.toContain(STAGING_DIR);
  });
});

describe('runUpgrade — package mode', () => {
  const PACKAGE_BIN = '/usr/lib/node_modules/rotorcc/dist/cli.js';

  it('--check compares the installed version with the registry', async () => {
    const { root, state } = fixture();
    // The package root is the fixture, so its package.json is the installed one.
    const packageBin = join(root, 'node_modules', 'rotorcc', 'dist', 'cli.js');
    mkdirSync(join(root, 'node_modules', 'rotorcc'), { recursive: true });
    writeFileSync(
      join(root, 'node_modules', 'rotorcc', 'package.json'),
      JSON.stringify({ name: 'rotorcc', version: '0.1.0' }),
    );
    const { exec, calls } = execFrom([
      ['npm view rotorcc version', ok('0.3.1\n')],
      ['rotorcc --version', ok('0.1.0\n')],
    ]);

    const { code, report } = await runUpgrade(
      baseOptions(root, state, {
        exec,
        check: true,
        binaryPath: packageBin,
        repoRoot: undefined,
      }) as never,
    );

    expect(report.mode).toBe('package');
    expect(report.latestPublished).toBe('0.3.1');
    expect(report.updateAvailable).toBe(true);
    expect(code).toBe(UPGRADE_AVAILABLE_OR_FAILED);
    expect(calls.some((c) => c.includes('install'))).toBe(false);
  });

  it('installs from the registry and re-checks what PATH now resolves to', async () => {
    const { root, state } = fixture();
    const packageDir = join(root, 'node_modules', 'rotorcc');
    mkdirSync(join(packageDir, 'dist'), { recursive: true });
    writeFileSync(
      join(packageDir, 'package.json'),
      JSON.stringify({ name: 'rotorcc', version: '0.1.0' }),
    );
    const { exec, calls } = execFrom([
      ['npm view rotorcc version', ok('0.2.0\n')],
      ['npm install --global rotorcc@latest', ok('added 1 package\n')],
      ['rotorcc --version', ok('0.2.0\n')],
      ['rotorcc doctor --json', DOCTOR_GREEN],
    ]);

    const { code, report } = await runUpgrade(
      baseOptions(root, state, {
        exec,
        binaryPath: join(packageDir, 'dist', 'cli.js'),
        repoRoot: undefined,
      }) as never,
    );

    expect(code).toBe(UPGRADE_OK);
    expect(report.applied).toBe(true);
    expect(report.after.version).toBe('0.2.0');
    expect(calls.some((c) => c === 'npm install --global rotorcc@latest')).toBe(true);
    expect(new Store(state).acquireLock('tick', 600)).toBe(true);
  });

  it('says so when the registry cannot be reached, rather than "already current"', async () => {
    const { root, state } = fixture();
    const { exec } = execFrom([['npm view rotorcc version', fail('ENOTFOUND registry.npmjs.org')]]);

    const { code, report } = await runUpgrade(
      baseOptions(root, state, {
        exec,
        check: true,
        binaryPath: PACKAGE_BIN,
        repoRoot: undefined,
      }) as never,
    );

    expect(code).toBe(UPGRADE_UNKNOWN);
    expect(report.updateAvailable).toBe(false);
    expect(stepStatus(report, 'registry')).toBe('failed');
  });

  it('explains an EACCES on the global prefix instead of just failing', async () => {
    const { root, state } = fixture();
    const { exec } = execFrom([
      ['npm view rotorcc version', ok('9.9.9\n')],
      ['npm install --global rotorcc@latest', fail('EACCES: permission denied, mkdir /usr/lib')],
    ]);

    const { code, report } = await runUpgrade(
      baseOptions(root, state, { exec, binaryPath: PACKAGE_BIN, repoRoot: undefined }) as never,
    );

    expect(code).toBe(UPGRADE_AVAILABLE_OR_FAILED);
    expect(report.notes.join(' ')).toContain('npm config set prefix');
  });

  it('catches an install that succeeded while PATH still resolves to the old copy', async () => {
    const { root, state } = fixture();
    const { exec } = execFrom([
      ['npm view rotorcc version', ok('0.5.0\n')],
      ['npm install --global rotorcc@latest', ok('added 1 package\n')],
      // A second, older rotorcc earlier on PATH wins. The install "worked" and
      // the operator is still running last week's build.
      ['rotorcc --version', ok('0.1.0\n')],
      ['rotorcc doctor --json', DOCTOR_GREEN],
    ]);

    const { code, report } = await runUpgrade(
      baseOptions(root, state, { exec, binaryPath: PACKAGE_BIN, repoRoot: undefined }) as never,
    );

    expect(code).toBe(UPGRADE_AVAILABLE_OR_FAILED);
    expect(report.ok).toBe(false);
    expect(stepDetail(report, 'binary')).toContain('shadowing');
  });
});

function stepStatus(report: UpgradeReport, name: string): string | undefined {
  return report.steps.find((step) => step.name === name)?.status;
}
function stepDetail(report: UpgradeReport, name: string): string {
  return report.steps
    .filter((step) => step.name === name)
    .map((s) => s.detail)
    .join(' ');
}
