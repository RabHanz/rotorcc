/**
 * The dashboard's actions drive the CLI's own code paths.
 *
 * That is the claim this file exists to keep honest, and it is kept the only
 * way it can be: by checking the WORLD afterwards rather than by asserting that
 * some function was called. `s` really moves the live credential, `d` really
 * writes the roster, `t` really rewrites the config file and re-validates it.
 * If the TUI ever grew a switch of its own, these tests would still pass while
 * the two implementations drifted — so each one asserts the effect that only
 * the real implementation produces.
 *
 * The other half is refusal. A pane that can switch accounts while the
 * every-minute watcher is halfway through switching them itself is a way to
 * lose a login, so every mutating action takes rotorcc's own tick lock first
 * and reports plainly when it could not.
 */
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { AccountManager } from '../src/accounts/manager.js';
import { asSecret, credentialFingerprint } from '../src/accounts/credentials.js';
import { loadConfig, saveConfig } from '../src/config/load.js';
import type { Config } from '../src/config/schema.js';
import {
  FLAG_ALL_EXHAUSTED,
  FLAG_ROTATE_NOW,
  FLAG_SOFT_CHECKPOINT,
  Store,
} from '../src/core/state.js';
import { type ActionContext, runAction } from '../src/tui/actions.js';
import { runTui } from '../src/tui/app.js';
import type { PendingAction } from '../src/tui/interaction.js';
import { cleanup, quietLogger, tempDir } from './helpers.js';

const dirs: string[] = [];
afterEach(() => cleanup(...dirs.splice(0)));

function oauth(tag: string): string {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: `at-${tag}`,
      refreshToken: `rt-${tag}`,
      expiresAt: Date.now() + 3_600_000,
    },
  });
}

interface World {
  ctx: ActionContext;
  manager: AccountManager;
  store: Store;
  configPath: string;
  claudeHome: string;
  env: NodeJS.ProcessEnv;
}

async function world(overrides: Partial<Config> = {}): Promise<World> {
  const root = tempDir('rotorcc-tui-actions-');
  dirs.push(root);
  const claudeHome = join(root, 'claude');
  const accountsDir = join(root, 'accounts');
  const stateDir = join(root, 'state');
  mkdirSync(claudeHome, { recursive: true });
  mkdirSync(accountsDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });

  // Every path this test touches lives under `root`, including the advisory
  // locks: a test that reaches into the developer's real ~/.claude to take a
  // credential lock is a test that can disturb a live session.
  const env: NodeJS.ProcessEnv = { HOME: root, CLAUDE_CONFIG_DIR: claudeHome };
  const manager = new AccountManager({ accountsDir, env });

  const configPath = join(root, 'config.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      version: 1,
      claudeHome,
      storePath: join(root, 'store'),
      projects: [{ path: join(root, 'project') }],
      accountsDir,
      strategy: 'work-aware',
      logging: { file: join(root, 'rotorcc.log'), level: 'error' },
    }),
    'utf8',
  );

  const config = { ...loadConfig(configPath), ...overrides };
  const store = new Store(stateDir);

  for (const [slot, email] of [
    [1, 'one@example.com'],
    [2, 'two@example.com'],
  ] as const) {
    manager.roster.update((r) => {
      r.accounts[String(slot)] = {
        email,
        uuid: '',
        organizationUuid: '',
        organizationName: '',
        added: '2026-08-20T00:00:00Z',
        alias: `slot${slot}`,
        disabled: false,
        kind: 'oauth',
      };
      if (slot === 1) r.activeSlot = 1;
    });
    manager.credentials.writeAccountIdentity(slot, email, { emailAddress: email });
    await manager.credentials.writeStash(slot, email, asSecret(oauth(email)));
  }
  // Slot 1 is what Claude Code is currently using.
  await manager.credentials.writeActive(asSecret(oauth('one@example.com')));

  return {
    ctx: {
      config,
      store,
      manager,
      logger: quietLogger,
      dryRun: overrides.dryRun === true,
      configPath,
    },
    manager,
    store,
    configPath,
    claudeHome,
    env,
  };
}

const action = (over: Partial<PendingAction> & { kind: PendingAction['kind'] }): PendingAction => ({
  label: 'test action',
  ...over,
});

describe('switching from the dashboard', () => {
  it('moves the live credential, exactly as "rotorcc switch <slot>" does', async () => {
    const w = await world();
    const before = await w.manager.credentials.readActive();
    expect(before.kind).toBe('found');

    const outcome = await runAction(
      w.ctx,
      action({ kind: 'switch', slot: 2, label: 'switch to slot 2' }),
    );

    expect(outcome.ok).toBe(true);
    // The proof that the real switch ran: the live credential is now slot 2's,
    // by fingerprint, and the roster records the move.
    const after = await w.manager.credentials.readActive();
    const stash = await w.manager.credentials.readStash(2, 'two@example.com');
    expect(after.kind).toBe('found');
    expect(stash.kind).toBe('found');
    if (after.kind !== 'found' || stash.kind !== 'found') return;
    expect(credentialFingerprint(after.value)).toBe(credentialFingerprint(stash.value));
    expect(w.manager.roster.read().activeSlot).toBe(2);
  });

  it("reports the command's own failure rather than a generic one", async () => {
    const w = await world();
    const outcome = await runAction(
      w.ctx,
      action({ kind: 'switch', slot: 99, label: 'switch to slot 99' }),
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.lines.join('\n')).toContain('no account matches "99"');
    // And nothing moved.
    expect(w.manager.roster.read().activeSlot).toBe(1);
  });

  it('changes nothing under --dry-run, and says so', async () => {
    const w = await world({ dryRun: true });
    const outcome = await runAction(
      w.ctx,
      action({ kind: 'switch', slot: 2, label: 'switch to slot 2' }),
    );
    expect(outcome.dryRun).toBe(true);
    expect(w.manager.roster.read().activeSlot).toBe(1);
  });
});

describe('disabling from the dashboard', () => {
  it('writes the roster, exactly as "rotorcc accounts disable" does', async () => {
    const w = await world();
    const off = await runAction(
      w.ctx,
      action({ kind: 'set-disabled', slot: 2, disabled: true, label: 'disable slot 2' }),
    );
    expect(off.ok).toBe(true);
    expect(w.manager.roster.read().accounts['2']?.disabled).toBe(true);
    expect(off.lines.join('\n')).toContain('held out of automatic rotation');

    const on = await runAction(
      w.ctx,
      action({ kind: 'set-disabled', slot: 2, disabled: false, label: 'enable slot 2' }),
    );
    expect(on.ok).toBe(true);
    expect(w.manager.roster.read().accounts['2']?.disabled).toBe(false);
  });
});

describe('changing the strategy from the dashboard', () => {
  it('rewrites the config file, exactly as "rotorcc config set strategy" does', async () => {
    const w = await world();
    const outcome = await runAction(
      w.ctx,
      action({ kind: 'set-strategy', strategy: 'consume-first', label: 'set strategy' }),
    );

    expect(outcome.ok).toBe(true);
    // On disk, and re-validated on the way in — which is the part that stops a
    // typo becoming a config the next start refuses to load.
    expect(JSON.parse(readFileSync(w.configPath, 'utf8')).strategy).toBe('consume-first');
    expect(loadConfig(w.configPath).strategy).toBe('consume-first');
    expect(outcome.lines.join('\n')).toContain(w.configPath);
  });

  it('writes nothing under --dry-run', async () => {
    const w = await world({ dryRun: true });
    await runAction(
      w.ctx,
      action({ kind: 'set-strategy', strategy: 'best', label: 'set strategy' }),
    );
    expect(loadConfig(w.configPath).strategy).toBe('work-aware');
  });
});

describe('clearing flags from the why panel', () => {
  it('clears the two that are instructions, and leaves the one that is a fact', async () => {
    const w = await world();
    const raise = (name: string) =>
      w.store.raiseFlag(name, { raisedAt: new Date().toISOString(), reason: 'test' });
    raise(FLAG_ROTATE_NOW);
    raise(FLAG_SOFT_CHECKPOINT);
    raise(FLAG_ALL_EXHAUSTED);

    const outcome = await runAction(w.ctx, action({ kind: 'clear-flags', label: 'clear flags' }));

    expect(outcome.ok).toBe(true);
    expect(w.store.peekFlag(FLAG_ROTATE_NOW)).toBeNull();
    expect(w.store.peekFlag(FLAG_SOFT_CHECKPOINT)).toBeNull();
    // ALL_ACCOUNTS_EXHAUSTED describes quota rather than instructing a session.
    // Clearing it by hand would hide it until the next tick raised it again.
    expect(w.store.peekFlag(FLAG_ALL_EXHAUSTED)).not.toBeNull();
    expect(outcome.lines.join('\n')).toContain('ALL_ACCOUNTS_EXHAUSTED is left alone');
  });
});

describe('the tick lock', () => {
  it('refuses to act while another rotorcc operation holds it, and changes nothing', async () => {
    const w = await world();
    // Stand in for a watcher tick that is mid-switch.
    expect(w.store.acquireLock('tick', 600)).toBe(true);

    const outcome = await runAction(
      w.ctx,
      action({ kind: 'switch', slot: 2, label: 'switch to slot 2' }),
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.lines.join('\n')).toContain('holds the lock');
    expect(w.manager.roster.read().activeSlot).toBe(1);
  });

  it('releases the lock again, so the next action and the next tick can run', async () => {
    const w = await world();
    await runAction(w.ctx, action({ kind: 'set-disabled', slot: 2, disabled: true, label: 'x' }));
    expect(w.store.acquireLock('tick', 600)).toBe(true);
    w.store.releaseLock('tick');
  });

  it('never steals a lock whose owner is alive, however long it has been held', async () => {
    const w = await world();
    // A tick holds this lock for its whole decide-and-act phase, which includes
    // a checkpoint sweep with pushes across every watched worktree. That can
    // legitimately run for minutes. A keypress that declared such a lock stale
    // would switch credentials underneath a tick that is itself mid-switch.
    expect(w.store.acquireLock('tick', 600)).toBe(true);
    const lockDir = join(w.store.dir, 'locks', 'tick');
    // Backdate it well past any plausible staleness window.
    const old = new Date(Date.now() - 6 * 3_600_000);
    utimesSync(lockDir, old, old);
    // The owner recorded in it is this process, which is alive.
    writeFileSync(join(lockDir, 'owner'), `${process.pid}\n${old.toISOString()}\n`, 'utf8');

    const outcome = await runAction(
      w.ctx,
      action({ kind: 'switch', slot: 2, label: 'switch to slot 2' }),
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.lines.join('\n')).toContain('holds the lock');
    expect(w.manager.roster.read().activeSlot).toBe(1);
  });

  it('does take over a lock whose owner is gone, so a killed watcher cannot block a key', async () => {
    const w = await world();
    expect(w.store.acquireLock('tick', 600)).toBe(true);
    // A pid that cannot exist: the lock's owner is definitively not running.
    writeFileSync(
      join(w.store.dir, 'locks', 'tick', 'owner'),
      `2147483646\n${new Date().toISOString()}\n`,
      'utf8',
    );
    const outcome = await runAction(
      w.ctx,
      action({ kind: 'set-disabled', slot: 2, disabled: true, label: 'disable slot 2' }),
    );
    expect(outcome.ok).toBe(true);
    expect(w.manager.roster.read().accounts['2']?.disabled).toBe(true);
  });

  it('releases it even when the action throws', async () => {
    const w = await world();
    // A manager whose roster read throws is the cheapest way to make the inner
    // command explode; the point is that the lock does not survive it.
    const broken: ActionContext = {
      ...w.ctx,
      manager: {
        ...w.manager,
        roster: {
          read: () => {
            throw new Error('roster is unreadable');
          },
          update: () => undefined,
        },
      } as never,
    };
    const outcome = await runAction(broken, action({ kind: 'switch', slot: 2, label: 'x' }));
    expect(outcome.ok).toBe(false);
    expect(outcome.lines.join('\n')).toContain('roster is unreadable');
    expect(w.store.acquireLock('tick', 600)).toBe(true);
    w.store.releaseLock('tick');
  });
});

describe('checkpointing from the why panel', () => {
  it('runs the real checkpoint and reports what it found', async () => {
    const w = await world();
    const outcome = await runAction(
      w.ctx,
      action({ kind: 'checkpoint', label: 'checkpoint every watched tree' }),
    );
    // The configured project does not exist in this temp world, so there is
    // genuinely nothing to save — but the checkpoint has to have RUN. Asserting
    // only that some output exists would stay green if `performCheckpoint`
    // threw, because the catch produces one line under the same title.
    expect(outcome.ok).toBe(true);
    expect(outcome.title).toBe('checkpoint every watched tree');
    expect(outcome.lines[0]).toMatch(/\d+ checkpointed · \d+ pushed · \d+ SKIPPED · \d+ failed/);
    expect(outcome.lines.join('\n')).not.toContain('the action failed');
  });

  it('leads with a summary, so a skip cannot be hidden by the four-line preview', async () => {
    const w = await world();
    const outcome = await runAction(
      w.ctx,
      action({ kind: 'checkpoint', label: 'checkpoint every watched tree' }),
    );
    // The pane shows the first few lines. A tree rotorcc could not save is
    // exactly the fact that must survive being summarised: an operator who
    // cannot see it rotates believing everything was saved.
    expect(outcome.lines[0]).toContain('SKIPPED');
  });
});

describe('what the pane shows afterwards', () => {
  it("carries the command's own output back, not a summary of it", async () => {
    const w = await world();
    const outcome = await runAction(
      w.ctx,
      action({ kind: 'set-disabled', slot: 2, disabled: true, label: 'disable slot 2' }),
    );
    // An action whose result you have to leave the pane to discover is only
    // half-built, so the outcome carries the lines the command printed.
    expect(outcome.title).toBe('disable slot 2');
    expect(outcome.lines.length).toBeGreaterThan(0);
    expect(Date.parse(outcome.at)).not.toBeNaN();
  });
});

describe('the read-only frame', () => {
  /** A stdout that is not a terminal, which is what a pipe or a cron mail is. */
  function fakeStdout(): { stream: NodeJS.WriteStream; written: () => string } {
    const chunks: string[] = [];
    const stream = {
      isTTY: false,
      columns: 120,
      rows: 40,
      write: (chunk: string) => {
        chunks.push(chunk);
        return true;
      },
      on: () => stream,
      off: () => stream,
    } as unknown as NodeJS.WriteStream;
    return { stream, written: () => chunks.join('') };
  }

  /** A stdin that records whether anybody tried to take the keyboard. */
  function fakeStdin(): { stream: NodeJS.ReadStream; rawModeCalls: () => number } {
    let calls = 0;
    const stream = {
      isTTY: true,
      setRawMode: () => {
        calls += 1;
        return stream;
      },
      resume: () => stream,
      pause: () => stream,
      setEncoding: () => stream,
      on: () => stream,
    } as unknown as NodeJS.ReadStream;
    return { stream, rawModeCalls: () => calls };
  }

  it('renders one frame and takes no keyboard when stdout is not a terminal', async () => {
    const w = await world();
    const out = fakeStdout();
    const input = fakeStdin();

    const code = await runTui({
      config: w.ctx.config,
      store: w.store,
      manager: w.manager,
      logger: quietLogger,
      configPath: w.configPath,
      dryRun: false,
      stdout: out.stream,
      stdin: input.stream,
    });

    expect(code).toBe(0);
    const frame = out.written();
    expect(frame).toContain('ACCOUNTS');
    // No cursor, no panel: a frame going into a cron mail must not look like a
    // control surface, and nothing may put a pipe's stdin into raw mode.
    expect(frame).not.toContain('❯');
    expect(frame).not.toContain('┌─');
    expect(input.rawModeCalls()).toBe(0);
    // And no alternate screen, which would be escape codes in a log file.
    expect(frame).not.toContain('[?1049h');
  });

  it('does the same for --once even on a real terminal', async () => {
    const w = await world();
    const out = fakeStdout();
    (out.stream as unknown as { isTTY: boolean }).isTTY = true;
    const input = fakeStdin();

    await runTui({
      config: w.ctx.config,
      store: w.store,
      manager: w.manager,
      logger: quietLogger,
      configPath: w.configPath,
      dryRun: false,
      once: true,
      stdout: out.stream,
      stdin: input.stream,
    });

    expect(input.rawModeCalls()).toBe(0);
    expect(out.written()).not.toContain('❯');
  });
});

describe('saveConfig round trip', () => {
  it('leaves a config the loader still accepts', async () => {
    // Guarding the strategy write from the other side: the picker uses the same
    // save path the CLI does, so a config it writes must reload.
    const w = await world();
    const config = loadConfig(w.configPath);
    saveConfig({ ...config, strategy: 'next-available' }, w.configPath);
    expect(loadConfig(w.configPath).strategy).toBe('next-available');
  });
});
