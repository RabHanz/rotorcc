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
import {
  FLAG_ALL_EXHAUSTED,
  FLAG_ROTATE_NOW,
  FLAG_SOFT_CHECKPOINT,
  Store,
} from '../src/core/state.js';
import { PendingSwitchStore } from '../src/core/nextSession.js';
import { renderStopNotice } from '../src/core/policy.js';
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

/**
 * Set each account's headroom.
 *
 * A number is headroom on BOTH windows, which is the common case and keeps the
 * older tests readable. A pair sets them independently, which the weekly-priority
 * policy makes necessary: "5 hours nearly gone, week fine" and "week nearly
 * gone" are now completely different situations and a test that cannot express
 * the difference cannot test the policy.
 */
type Headroom = number | { fiveHour: number; sevenDay: number };

function setUsage(statePath: string, headroom: Record<number, Headroom>, active: number): void {
  const accounts = Object.entries(headroom).map(([number, value]) => {
    const fiveHour = typeof value === 'number' ? value : value.fiveHour;
    const sevenDay = typeof value === 'number' ? value : value.sevenDay;
    return {
      number: Number(number),
      email: `a${number}@example.com`,
      alias: `a${number}`,
      active: Number(number) === active,
      usageStatus: 'ok',
      usage: {
        fiveHour: { pct: 100 - fiveHour, resetsAt: '2026-08-18T05:00:00+00:00' },
        sevenDay: { pct: 100 - sevenDay, resetsAt: '2026-08-24T05:00:00+00:00' },
        scoped: [{ pct: 0, name: 'Fable', resetsAt: '2026-08-24T05:00:00+00:00' }],
      },
    };
  });
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
    // Pointed at a temp directory on purpose. Without it these tests would read
    // whatever accounts the developer running them actually has, and a suite
    // that reaches for real credentials — or the network behind them — is a
    // suite that fails differently on every machine.
    accountsDir: join(root, 'accounts'),
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

  it('5-hour window low but the WEEK healthy: checkpoints and stays put', async () => {
    // The weekly-priority rule. The 5h window refills several times a day, so
    // burning a second account's WEEK to escape it is a bad trade. rotorcc
    // saves everything and waits for the window instead.
    setUsage(usageState, { 1: { fiveHour: 8, sevenDay: 90 }, 2: 90, 3: 95 }, 1);
    const result = await tick(ctx());

    expect(result.actionsTaken).toContain('policy-checkpoint');
    expect(result.detail).toContain('weekly window is healthy');

    const worktree = join(repo, '.claude', 'worktrees', 'agent-1');
    expect(git(worktree, 'status', '--porcelain').trim()).toBe('');
    expect(git(remote, 'log', '-1', '--format=%s', 'work/agent-1')).toContain('auto-checkpoint');

    // Nothing was queued and nothing was switched.
    expect(new PendingSwitchStore(store.dir).peek()).toBeNull();
    expect(cswapCalls().every((call) => call[0] !== 'switch')).toBe(true);
  });

  it('WEEKLY window low: queues a handover and never interrupts the running session', async () => {
    // The redesign, 2026-08-19. This test previously asserted the model that
    // corrupted a live session: checkpoint, switch the credential underneath a
    // running process, and spawn a `claude --continue` beside it. A live session
    // reads its credential once at launch and cannot be hot-swapped, so that
    // was abandon-and-replace, and it put two operators on one worktree.
    //
    // Now: record which account the NEXT session opens on, checkpoint, and
    // leave the running one entirely alone.
    setUsage(usageState, { 1: { fiveHour: 60, sevenDay: 3 }, 2: 40, 3: 95 }, 1);
    const result = await tick(ctx());

    expect(result.actionsTaken).toContain('handover-queued');
    // The critical assertion: no switch, and nothing spawned.
    expect(result.actionsTaken.some((a) => a.startsWith('switched'))).toBe(false);
    expect(result.actionsTaken.some((a) => a.startsWith('successor'))).toBe(false);
    expect(cswapCalls().every((call) => call[0] !== 'switch')).toBe(true);

    const pending = new PendingSwitchStore(store.dir).peek();
    expect(pending?.slot).toBe(3);
    expect(pending?.reason).toContain('next session will open on');
    expect(pending?.expiresAt).toBeDefined();

    // And the work is safe in the meantime, because this session keeps running
    // on an account that is nearly out.
    expect(git(remote, 'log', '-1', '--format=%s', 'work/agent-1')).toContain('auto-checkpoint');
  });

  it('picks the account with the most WEEKLY headroom, not the most 5-hour', async () => {
    // #2 looks best on the 5h window and is nearly out of week; #3 is the
    // opposite. The next session should open on #3.
    setUsage(
      usageState,
      {
        1: { fiveHour: 50, sevenDay: 2 },
        2: { fiveHour: 99, sevenDay: 6 },
        3: { fiveHour: 30, sevenDay: 80 },
      },
      1,
    );
    await tick(ctx());
    expect(new PendingSwitchStore(store.dir).peek()?.slot).toBe(3);
  });

  it('ALL accounts out of weekly quota: STOPS, spawns nothing, queues nothing', async () => {
    setUsage(usageState, { 1: 3, 2: 4, 3: 2 }, 1);
    const result = await tick(ctx());

    expect(result.actionsTaken).toContain('policy-stop');
    expect(result.decision?.reason).toContain('STOPPED');

    // Nothing was rotated, nothing spawned, and — the part that matters —
    // nothing was QUEUED either. A handover to an exhausted account would just
    // move the problem to the next session start.
    expect(result.actionsTaken.some((a) => a.startsWith('switched'))).toBe(false);
    expect(result.actionsTaken.some((a) => a.startsWith('successor'))).toBe(false);
    expect(new PendingSwitchStore(store.dir).peek()).toBeNull();
    expect(cswapCalls().every((call) => call[0] !== 'switch')).toBe(true);

    // The operator is told, unmistakably, on a flag of its own.
    const flag = store.readFlag(FLAG_ALL_EXHAUSTED);
    expect(flag).not.toBeNull();
    expect(flag?.reason).toContain('every account is at or below');

    // A manifest is still written and the work is still pushed: stopping is not
    // the same as giving up on durability.
    expect(store.latestManifest()).not.toBeNull();
    expect(git(remote, 'log', '-1', '--format=%s', 'work/agent-1')).toContain('auto-checkpoint');
  });

  it('the stop notice names every account, its headroom and its reset time', () => {
    const notice = renderStopNotice({
      kind: 'stop',
      reason: 'every account is at or below 5% weekly headroom.',
      accounts: [
        {
          slot: 1,
          label: 'work',
          headroomPct: 2,
          window: '7d',
          resetsAt: '2026-08-24T09:00:00Z',
          why: 'the account in use',
        },
        {
          slot: 2,
          label: 'spare',
          headroomPct: null,
          window: 'unknown',
          resetsAt: null,
          why: 'quota read failed: http-429',
        },
      ],
    });

    expect(notice).toContain('rotorcc has STOPPED');
    expect(notice).toContain('No rotation was performed');
    expect(notice).toContain('2026-08-24 09:00');
    // An account that could not be measured says so rather than being omitted:
    // "we could not read this" and "this is empty" mean different things, and
    // only one of them means waiting will help.
    expect(notice).toContain('unknown');
    expect(notice).toContain('http-429');
    expect(notice).toContain('rotorcc accounts add');
  });

  it('does NOT treat a limit message as a hard kill while the session is alive', async () => {
    // Updated 2026-08-19. This test previously asserted the exact defect that
    // corrupted a live session: a limit string in the transcript triggered a
    // hard-kill rotation "whatever the numbers say" — and the string was a
    // SUBAGENT dying, not the operator. Liveness is now ground truth: a signature
    // in the tail of a LIVE session is ignored. Rotation on genuine low headroom
    // still happens (that is what `switched:` is), but never a hard-kill
    // successor onto a running session.
    setUsage(usageState, { 1: 95, 2: 20, 3: 99 }, 1);
    appendTranscript(
      '{"type":"assistant","text":"You\'ve hit your session limit · resets at 5am"}',
    );

    // The e2e harness's session process is the live test runner, so the session
    // reads as alive. A hard kill must NOT be declared.
    const result = await tick(ctx());
    expect(result.hardKill).toBeNull();
  });

  it('changes nothing on disk under --dry-run', async () => {
    setUsage(usageState, { 1: 3, 2: 40, 3: 95 }, 1);
    const worktree = join(repo, '.claude', 'worktrees', 'agent-1');
    const before = git(worktree, 'rev-parse', 'HEAD');

    const result = await tick(ctx(true));
    expect(git(worktree, 'rev-parse', 'HEAD')).toBe(before);
    expect(git(worktree, 'status', '--porcelain')).toContain('in-progress.ts');
    expect(cswapCalls().every((call) => call[0] !== 'switch')).toBe(true);
    expect(result.actionsTaken).toContain('dry-run-handover-queued');

    // A simulated handover must not be actionable either. The pending intent
    // is written so the dry run can be inspected, but it carries `dryRun` and
    // `consume()` refuses it — a simulation cannot decide which account a real
    // session opens on.
    const pending = new PendingSwitchStore(store.dir);
    expect(pending.peek()?.dryRun).toBe(true);
    expect(pending.consume()).toBeNull();

    // A handover writes no manifest, in a dry run or otherwise: nothing is
    // ending, so there is no resume plan to write.
    expect(store.latestManifest()).toBeNull();
  });

  it('a dry-run STOP writes its manifest where no resume path will read it', async () => {
    // The 2026-08-18 defect: a simulated run's manifest, every row of which read
    // "would commit 345 file(s)", was surfaced by the resume banner as a rescue
    // record while thirteen trees sat unpushed for twenty hours.
    //
    // The stop path is the one that still writes a manifest, so this is where
    // that regression lives now.
    setUsage(usageState, { 1: 3, 2: 4, 3: 2 }, 1);
    const result = await tick(ctx(true));
    expect(result.actionsTaken).toContain('policy-stop');

    // Not reachable by `resume`, or by the crash-reconstruction hook.
    expect(store.latestManifest()).toBeNull();

    const dryRunDir = join(root, 'state', 'manifests', 'dry-run');
    expect(existsSync(dryRunDir)).toBe(true);
    const simulated = readdirSync(dryRunDir).filter((f) => f.endsWith('.md'));
    expect(simulated.length).toBeGreaterThan(0);
    const markdown = readFileSync(join(dryRunDir, simulated[0] as string), 'utf8');
    expect(markdown).toContain('DRY RUN — NOTHING IN THIS DOCUMENT WAS ACTUALLY DONE');
    expect(markdown).toContain('Do not treat this as a rescue record');

    // And a dry run does not raise the exhausted flag either.
    expect(store.peekFlag(FLAG_ALL_EXHAUSTED)).toBeNull();
  });

  it('a dry run never raises a flag a live session would obey', async () => {
    // The 2026-08-18 defect in its other half: a ROTATE_NOW written by a dry
    // run survived on disk and was handed to a healthy live session hours
    // later, which was told to stop dispatching work and exit.
    setUsage(usageState, { 1: 3, 2: 40, 3: 95 }, 1);
    const result = await tick(ctx(true));

    expect(result.actionsTaken).toContain('dry-run-handover-queued');
    expect(store.readFlag(FLAG_ROTATE_NOW)).toBeNull();
    expect(store.readFlag(FLAG_SOFT_CHECKPOINT)).toBeNull();
    expect(store.readFlag(FLAG_ALL_EXHAUSTED)).toBeNull();
    // Not merely filtered on read — not on disk at all.
    expect(store.peekFlag(FLAG_ROTATE_NOW)).toBeNull();
  });

  it('drops a raised flag once the level that justified it stops holding', () => {
    // Driven through the Store directly rather than through a tick.
    //
    // The weekly-priority redesign means the watcher no longer raises
    // ROTATE_NOW under a live session — it queues a handover instead. But the
    // flag still exists for the dead-session path, and its expiry semantics
    // are what the 2026-08-18 defect was about, so they get pinned at the
    // level that actually owns them.
    store.raiseFlag(FLAG_ROTATE_NOW, {
      raisedAt: new Date().toISOString(),
      level: 'rotate',
      reason: 'a real rotation happened',
      targetAccount: 3,
    });
    expect(store.readFlag(FLAG_ROTATE_NOW)).not.toBeNull();

    // The window resets and the account is healthy again. The flag now
    // describes a world that no longer exists, and a reader that supplies the
    // current level must not be handed it.
    expect(store.readFlag(FLAG_ROTATE_NOW, { currentLevel: 'ok' })).toBeNull();
    expect(store.peekFlag(FLAG_ROTATE_NOW)).toBeNull();
  });

  it('drops a raised flag once its TTL has passed', () => {
    store.raiseFlag(FLAG_ROTATE_NOW, {
      raisedAt: new Date().toISOString(),
      level: 'rotate',
      reason: 'a real rotation happened',
    });
    expect(store.peekFlag(FLAG_ROTATE_NOW)?.expiresAt).toBeDefined();

    // Still live a minute later.
    expect(store.readFlag(FLAG_ROTATE_NOW, { nowMs: Date.now() + 60_000 })).not.toBeNull();
    // Gone an hour later. A rotation signal is about right now; one that
    // survives for hours is not stale information, it is wrong information.
    expect(store.readFlag(FLAG_ROTATE_NOW, { nowMs: Date.now() + 3_600_000 })).toBeNull();
  });

  it('latches, so a stuck-at-low account is checkpointed once and not every minute', async () => {
    // The policy path needs a latch just as much as the threshold path it
    // replaced. A daemon that checkpoints on every tick while a window sits low
    // is a commit and a push every sixty seconds for four hours — which is
    // exactly what happened on a busy orchestrator on 2026-08-18.
    setUsage(usageState, { 1: { fiveHour: 8, sevenDay: 90 }, 2: 90, 3: 95 }, 1);
    const first = await tick(ctx());
    expect(first.actionsTaken).toContain('policy-checkpoint');

    const second = await tick(ctx());
    expect(second.actionsTaken).toEqual([]);

    const third = await tick(ctx());
    expect(third.actionsTaken).toEqual([]);
  });

  it('latches a queued handover too, so it is not re-queued every tick', async () => {
    setUsage(usageState, { 1: { fiveHour: 60, sevenDay: 3 }, 2: 40, 3: 95 }, 1);
    const first = await tick(ctx());
    expect(first.actionsTaken).toContain('handover-queued');

    const second = await tick(ctx());
    expect(second.actionsTaken).toEqual([]);
    // The intent itself survives — it is the repeated CHECKPOINT beside it that
    // had to stop, not the decision.
    expect(new PendingSwitchStore(store.dir).peek()?.slot).toBe(3);
  });

  it('gives the all-exhausted notice once per window, not every minute', async () => {
    setUsage(usageState, { 1: 3, 2: 4, 3: 2 }, 1);
    const first = await tick(ctx());
    expect(first.actionsTaken).toContain('policy-stop');

    // A full-screen stop banner every sixty seconds trains an operator to
    // scroll past it, which defeats the one job it has.
    const second = await tick(ctx());
    expect(second.actionsTaken).toEqual([]);
    expect(second.decision?.reason).toContain('notice already given');
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
    expect(result.actionsTaken.some((a) => a.startsWith('switched'))).toBe(false);
    expect(result.actionsTaken).toContain('policy-checkpoint');
    expect(result.detail).toContain('rotation is disabled');
    // It still NAMES the account a human should move to. Refusing to act is
    // not a reason to refuse to inform.
    expect(result.detail).toContain('slot 3');
    expect(cswapCalls().every((call) => call[0] !== 'switch')).toBe(true);

    // And — the part that would otherwise be a hole in the promise — it does
    // not queue a handover either. An intent SessionStart would act on is still
    // rotorcc changing the account by itself, just later.
    expect(new PendingSwitchStore(store.dir).peek()).toBeNull();

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
    // The failure has to be legible AND actionable. A machine with no rotorcc
    // accounts of its own falling back to a broken external switcher is the
    // exact state that has to name its own remedy, or the operator is left
    // watching a tool that silently does nothing.
    expect(result.detail).toContain('rotorcc manages no accounts of its own');
    expect(result.detail).toContain('rotorcc accounts import');
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
