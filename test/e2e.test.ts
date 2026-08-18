/**
 * End to end, with the outside world faked but nothing else.
 *
 * The account switcher, the CLI and the terminal are replaced with small Node
 * scripts that record what they were asked to do. Everything else is real: real
 * git repositories, a real transcript store, a real secrets screen, real
 * manifests. That is where the bugs live — in the seams between those pieces,
 * not in the parts a mock could stand in for.
 *
 * Node scripts rather than shell scripts so this runs identically on Windows.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseConfig } from '../src/config/load.js';
import type { Config } from '../src/config/schema.js';
import { performCheckpoint } from '../src/core/checkpoint.js';
import { tick } from '../src/core/daemon.js';
import { emptyState } from '../src/core/decide.js';
import { Logger } from '../src/core/log.js';
import { parseManifest } from '../src/core/manifest.js';
import { projectSlug } from '../src/core/paths.js';
import { FLAG_ROTATE_NOW, FLAG_SOFT_CHECKPOINT, Store } from '../src/core/state.js';
import { cleanup, tempDir } from './helpers.js';

let root: string;
let repo: string;
let remote: string;
let claudeHome: string;
let store: Store;
let config: Config;
let fakeCswapLog: string;

const logger = new Logger({ level: 'error' });

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  });
}

/** A stand-in for the account switcher, driven by a JSON file on disk. */
function writeFakeCswap(scriptPath: string, statePath: string, logPath: string): void {
  writeFileSync(
    scriptPath,
    `import { appendFileSync, readFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(args) + '\\n');
if (args[0] === 'list') {
  process.stdout.write(readFileSync(${JSON.stringify(statePath)}, 'utf8'));
  process.exit(0);
}
if (args[0] === 'switch') { process.stdout.write('switched\\n'); process.exit(0); }
process.exit(0);
`,
    'utf8',
  );
}

function setUsage(statePath: string, headroom: Record<number, number>, active: number): void {
  const accounts = Object.entries(headroom).map(([number, pct]) => ({
    number: Number(number),
    email: `a${number}@example.com`,
    alias: `a${number}`,
    active: Number(number) === active,
    usageStatus: 'ok',
    usage: {
      fiveHour: { pct: 100 - pct, resetsAt: '2026-08-18T05:00:00+00:00' },
      sevenDay: { pct: 0, resetsAt: '2026-08-24T05:00:00+00:00' },
      scoped: [{ pct: 0, name: 'Fable', resetsAt: '2026-08-24T05:00:00+00:00' }],
    },
  }));
  writeFileSync(
    statePath,
    JSON.stringify({ schemaVersion: 1, activeAccountNumber: active, accounts }, null, 2),
    'utf8',
  );
}

function transcriptDir(): string {
  return join(claudeHome, 'projects', projectSlug(repo));
}

function appendTranscript(text: string): void {
  const dir = transcriptDir();
  mkdirSync(join(dir, 'session-1', 'subagents'), { recursive: true });
  const file = join(dir, 'session-1.jsonl');
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : '';
  writeFileSync(file, `${existing}${text}\n`, 'utf8');
  writeFileSync(
    join(dir, 'session-1', 'subagents', 'agent-a1.jsonl'),
    '{"type":"assistant","text":"agent work"}\n',
    'utf8',
  );
}

let usageState: string;

beforeEach(() => {
  root = tempDir('rotorcc-e2e-');
  repo = join(root, 'project');
  remote = join(root, 'remote.git');
  claudeHome = join(root, 'claude');
  usageState = join(root, 'usage.json');
  fakeCswapLog = join(root, 'cswap-calls.log');

  mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '--bare', '-b', 'main', remote]);
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'remote', 'add', 'origin', remote);
  writeFileSync(join(repo, 'README.md'), 'seed\n');
  // Agent worktrees live under .claude/, which projects normally ignore. Without
  // this the main tree is permanently dirty and every assertion about it is noise.
  writeFileSync(join(repo, '.gitignore'), '.claude/\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-m', 'seed');
  git(repo, 'push', '-u', 'origin', 'main');

  // One agent worktree with unpushed, uncommitted work: the thing to rescue.
  const worktree = join(repo, '.claude', 'worktrees', 'agent-1');
  mkdirSync(join(repo, '.claude', 'worktrees'), { recursive: true });
  git(repo, 'worktree', 'add', '-b', 'work/agent-1', worktree);
  writeFileSync(join(worktree, 'in-progress.ts'), 'export const half = "written";\n');
  writeFileSync(join(worktree, 'checkpoint-agent-1.md'), '# where I got to\n');

  appendTranscript('{"type":"user","text":"do the thing"}');

  const fakeCswap = join(root, 'fake-cswap.mjs');
  writeFakeCswap(fakeCswap, usageState, fakeCswapLog);
  setUsage(usageState, { 1: 80, 2: 90, 3: 95 }, 1);

  config = parseConfig({
    version: 1,
    claudeHome,
    storePath: join(root, 'store'),
    projects: [
      {
        path: repo,
        checkpointGlobs: ['**/checkpoint-*.md'],
      },
    ],
    commands: { cswap: [process.execPath, fakeCswap] },
    successor: { launcher: 'none' },
    snapshot: { debounceSeconds: 0 },
    logging: { file: join(root, 'rotorcc.log'), level: 'error' },
  });

  store = new Store(join(root, 'state'));
  store.ensure();
  store.writeState(emptyState());
});

afterEach(() => {
  cleanup(root);
});

function ctx(dryRun = false) {
  return { config, store, logger, dryRun };
}

function cswapCalls(): string[][] {
  if (!existsSync(fakeCswapLog)) return [];
  return readFileSync(fakeCswapLog, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as string[]);
}

describe('end to end', () => {
  it('does nothing while there is headroom, and says so', async () => {
    const result = await tick(ctx());
    expect(result.ok).toBe(true);
    expect(result.decision?.level).toBe('ok');
    expect(result.actionsTaken).toEqual([]);
    // and it did not touch the working tree
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  it('copies transcripts into a git store and commits them', async () => {
    const result = await performCheckpoint({
      config,
      store,
      logger,
      trigger: 'test',
      dryRun: false,
      skipLanes: true,
    });
    expect(result.snapshot?.filesCopied).toBeGreaterThan(0);
    expect(result.snapshot?.commit).not.toBeNull();

    const copied = join(config.storePath, 'projects', projectSlug(repo), 'session-1.jsonl');
    expect(existsSync(copied)).toBe(true);
    expect(readFileSync(copied, 'utf8')).toContain('do the thing');
    expect(
      existsSync(
        join(
          config.storePath,
          'projects',
          projectSlug(repo),
          'session-1',
          'subagents',
          'agent-a1.jsonl',
        ),
      ),
    ).toBe(true);
    expect(git(config.storePath, 'log', '--format=%s')).toContain('snapshot: test');
  });

  it('copies only the new bytes on the second snapshot', async () => {
    await performCheckpoint({
      config,
      store,
      logger,
      trigger: 'first',
      dryRun: false,
      skipLanes: true,
    });
    const second = await performCheckpoint({
      config,
      store,
      logger,
      trigger: 'second',
      dryRun: false,
      skipLanes: true,
    });
    expect(second.snapshot?.filesCopied).toBe(0);

    appendTranscript('{"type":"assistant","text":"done"}');
    const third = await performCheckpoint({
      config,
      store,
      logger,
      trigger: 'third',
      dryRun: false,
      skipLanes: true,
    });
    expect(third.snapshot?.filesCopied).toBeGreaterThan(0);
  });

  it('at the soft threshold: checkpoints the lane, raises the flag, does not switch', async () => {
    setUsage(usageState, { 1: 8, 2: 90, 3: 95 }, 1);
    const result = await tick(ctx());

    expect(result.decision?.level).toBe('soft');
    expect(result.actionsTaken).toContain('soft-checkpoint');

    const worktree = join(repo, '.claude', 'worktrees', 'agent-1');
    expect(git(worktree, 'status', '--porcelain').trim()).toBe('');
    expect(git(remote, 'log', '-1', '--format=%s', 'work/agent-1')).toContain(
      'auto-checkpoint soft-checkpoint',
    );

    const flag = store.readFlag(FLAG_SOFT_CHECKPOINT);
    expect(flag).not.toBeNull();
    expect(flag?.reason).toContain('commit, push');
    expect(store.readFlag(FLAG_ROTATE_NOW)).toBeNull();
    expect(cswapCalls().every((call) => call[0] !== 'switch')).toBe(true);
  });

  it('at the rotate threshold: writes a manifest, raises the flag, switches account', async () => {
    setUsage(usageState, { 1: 3, 2: 40, 3: 95 }, 1);
    const result = await tick(ctx());

    expect(result.decision?.level).toBe('rotate');
    expect(result.actionsTaken).toContain('manifest');
    expect(result.actionsTaken).toContain('switched:3');
    expect(cswapCalls()).toContainEqual(['switch', '3']);

    const manifestPath = store.latestManifest();
    expect(manifestPath).not.toBeNull();
    const manifest = parseManifest(JSON.parse(readFileSync(manifestPath ?? '', 'utf8')));
    expect(manifest.trigger).toBe('rotate');
    expect(manifest.accounts.targetNumber).toBe(3);
    expect(manifest.cleanExit).toBe(false);

    const lane = manifest.projects[0]?.trees.find((t) => t.branch === 'work/agent-1');
    expect(lane?.checkpoint?.pushed).toBe(true);
    expect(lane?.notes).toContain('checkpoint-agent-1.md');

    const markdown = readFileSync((manifestPath ?? '').replace(/\.json$/, '.md'), 'utf8');
    expect(markdown).toContain('work/agent-1');
    expect(markdown).toContain('Do this first');

    const flag = store.readFlag(FLAG_ROTATE_NOW);
    expect(flag?.targetAccount).toBe(3);
    expect(flag?.manifestMarkdownPath).toBeDefined();
  });

  it('refuses to rotate when every other account is spent, and checkpoints instead', async () => {
    setUsage(usageState, { 1: 3, 2: 4, 3: 2 }, 1);
    const result = await tick(ctx());

    expect(result.actionsTaken.some((a) => a.startsWith('switched'))).toBe(false);
    expect(result.actionsTaken.some((a) => a.includes('no account has'))).toBe(true);
    expect(result.actionsTaken).toContain('soft-checkpoint');
    expect(cswapCalls().every((call) => call[0] !== 'switch')).toBe(true);
    // the work is still safe
    expect(git(remote, 'log', '-1', '--format=%s', 'work/agent-1')).toContain('auto-checkpoint');
  });

  it('treats a limit message in the transcript as a rotation, whatever the numbers say', async () => {
    setUsage(usageState, { 1: 95, 2: 20, 3: 99 }, 1);
    appendTranscript(
      '{"type":"assistant","text":"You\'ve hit your session limit · resets at 5am"}',
    );

    const result = await tick(ctx());
    expect(result.hardKill).toBe('limit-signature');
    expect(result.actionsTaken).toContain('switched:3');
  });

  it('changes nothing on disk under --dry-run', async () => {
    setUsage(usageState, { 1: 3, 2: 40, 3: 95 }, 1);
    const worktree = join(repo, '.claude', 'worktrees', 'agent-1');
    const before = git(worktree, 'rev-parse', 'HEAD');

    const result = await tick(ctx(true));
    expect(result.decision?.level).toBe('rotate');
    expect(git(worktree, 'rev-parse', 'HEAD')).toBe(before);
    expect(git(worktree, 'status', '--porcelain')).toContain('in-progress.ts');
    expect(cswapCalls().every((call) => call[0] !== 'switch')).toBe(true);
    expect(result.actionsTaken).toContain('dry-run-switch:3');
    // the manifest is still written: a plan costs nothing and is the point
    expect(store.latestManifest()).not.toBeNull();
  });

  it('latches, so a stuck-at-low account is checkpointed once and not every minute', async () => {
    setUsage(usageState, { 1: 8, 2: 90, 3: 95 }, 1);
    const first = await tick(ctx());
    expect(first.actionsTaken).toContain('soft-checkpoint');

    const second = await tick(ctx());
    expect(second.actionsTaken).toEqual([]);

    const third = await tick(ctx());
    expect(third.actionsTaken).toEqual([]);
  });

  it('refuses the off-machine mirror when the new transcript bytes look like a credential', async () => {
    const mirrorTarget = join(root, 'mirror');
    mkdirSync(mirrorTarget, { recursive: true });
    config = parseConfig({
      ...JSON.parse(JSON.stringify(config)),
      mirror: { type: 'rsync-ssh', target: mirrorTarget, timeoutSeconds: 30 },
    });

    appendTranscript('{"type":"user","text":"AWS_SECRET_ACCESS_KEY=8f2b91c4d7e6a05b3f1c9d8e"}');
    const result = await performCheckpoint({
      config,
      store,
      logger,
      trigger: 'test',
      dryRun: false,
      skipLanes: true,
    });

    expect(result.snapshot?.secretHits.length).toBeGreaterThan(0);
    expect(result.snapshot?.mirror.attempted).toBe(false);
    expect(result.snapshot?.mirror.detail).toContain('refused');
    // the local copy was still made: those bytes were already on this disk
    expect(result.snapshot?.commit).not.toBeNull();
    expect(readdirSync(mirrorTarget)).toHaveLength(0);
    // and nothing in the excerpt reproduces the value
    expect(JSON.stringify(result.snapshot?.secretHits)).not.toContain('8f2b91c4d7e6a05b3f1c9d8e');
  });

  it('with onHit "skip-file", a secret-bearing transcript never enters the store', async () => {
    config = parseConfig({
      ...(JSON.parse(JSON.stringify(config)) as object),
      secretsScreen: { enabled: true, onHit: 'skip-file' },
    });

    // One clean transcript and one carrying a credential shape.
    const dir = transcriptDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'clean.jsonl'), '{"type":"user","text":"ordinary work"}\n');
    writeFileSync(
      join(dir, 'tainted.jsonl'),
      '{"type":"user","text":"AWS_SECRET_ACCESS_KEY=8f2b91c4d7e6a05b3f1c9d8e"}\n',
    );

    const result = await performCheckpoint({
      config,
      store,
      logger,
      trigger: 'test',
      dryRun: false,
      skipLanes: true,
    });

    const storeDir = join(config.storePath, 'projects', projectSlug(repo));
    expect(existsSync(join(storeDir, 'clean.jsonl'))).toBe(true);
    // The point of skip-file: it is not in the store, so it is not in history.
    expect(existsSync(join(storeDir, 'tainted.jsonl'))).toBe(false);
    expect(result.snapshot?.skipped.join(' ')).toContain('tainted.jsonl');
    expect(result.snapshot?.secretHits.length).toBeGreaterThan(0);
    // The original is untouched where it already was.
    expect(existsSync(join(dir, 'tainted.jsonl'))).toBe(true);
    expect(git(config.storePath, 'log', '--stat', '-1')).not.toContain('tainted.jsonl');
  });

  it('retracts a copy an earlier, laxer policy already made', async () => {
    const dir = transcriptDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'later-tainted.jsonl'), '{"type":"user","text":"still clean"}\n');

    // First pass under the default policy: the file is copied.
    await performCheckpoint({
      config,
      store,
      logger,
      trigger: 'a',
      dryRun: false,
      skipLanes: true,
    });
    const stored = join(config.storePath, 'projects', projectSlug(repo), 'later-tainted.jsonl');
    expect(existsSync(stored)).toBe(true);

    // The transcript then picks up something credential-shaped, and the policy
    // tightens. Leaving the earlier copy would be the worst of both worlds.
    writeFileSync(
      join(dir, 'later-tainted.jsonl'),
      '{"type":"user","text":"still clean"}\n{"type":"user","text":"GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789"}\n',
    );
    config = parseConfig({
      ...(JSON.parse(JSON.stringify(config)) as object),
      secretsScreen: { enabled: true, onHit: 'skip-file' },
    });

    const result = await performCheckpoint({
      config,
      store,
      logger,
      trigger: 'b',
      dryRun: false,
      skipLanes: true,
    });
    expect(existsSync(stored)).toBe(false);
    expect(result.snapshot?.skipped.join(' ')).toContain('earlier copy retracted');
    // History is a different question, and the tool does not pretend otherwise.
    expect(git(config.storePath, 'log', '--all', '--oneline', '--', stored)).not.toBe('');
  });

  it('with onHit "fail-closed", nothing is copied at all', async () => {
    config = parseConfig({
      ...(JSON.parse(JSON.stringify(config)) as object),
      secretsScreen: { enabled: true, onHit: 'fail-closed' },
    });
    appendTranscript('{"type":"user","text":"AWS_SECRET_ACCESS_KEY=8f2b91c4d7e6a05b3f1c9d8e"}');

    const result = await performCheckpoint({
      config,
      store,
      logger,
      trigger: 'test',
      dryRun: false,
      skipLanes: true,
    });
    expect(result.snapshot?.filesCopied).toBe(0);
    expect(result.snapshot?.commit).toBeNull();
    expect(result.snapshot?.mirror.detail).toContain('abandoned');
  });

  it('with rotation disabled it checkpoints at the rotate threshold but never switches', async () => {
    config = parseConfig({
      ...(JSON.parse(JSON.stringify(config)) as object),
      rotation: { enabled: false },
    });
    setUsage(usageState, { 1: 3, 2: 40, 3: 95 }, 1);

    const result = await tick(ctx());
    expect(result.decision?.level).toBe('rotate');
    expect(result.actionsTaken.some((a) => a.startsWith('switched'))).toBe(false);
    expect(result.actionsTaken.some((a) => a.startsWith('dry-run-switch'))).toBe(false);
    expect(result.actionsTaken.join(' ')).toContain('rotation is disabled');
    expect(result.actionsTaken).toContain('soft-checkpoint');
    expect(cswapCalls().every((call) => call[0] !== 'switch')).toBe(true);
    // The work is still safe, which is the part that actually matters.
    expect(git(remote, 'log', '-1', '--format=%s', 'work/agent-1')).toContain('auto-checkpoint');
  });

  it('survives a usage source that is broken, without touching anything', async () => {
    config = parseConfig({
      ...JSON.parse(JSON.stringify(config)),
      commands: { cswap: [process.execPath, join(root, 'does-not-exist.mjs')] },
    });
    const result = await tick(ctx());
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('usage source');
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  it('skips a tick that would overlap another operation rather than running twice', async () => {
    expect(store.acquireLock('tick', 600)).toBe(true);
    try {
      const result = await tick(ctx());
      expect(result.detail).toContain('holds the lock');
      expect(result.actionsTaken).toEqual([]);
    } finally {
      store.releaseLock('tick');
    }
  });
});
