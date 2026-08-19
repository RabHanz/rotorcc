/**
 * Hot-swapping a live session onto another account.
 *
 * The behaviour under test was measured, not assumed: a Claude Code session
 * reads its credential per request, so changing the file moves the session.
 * See docs/adr/0003-live-credential-hot-swap.md for the experiment.
 *
 * What these tests are really about is the VERIFICATION, because a hot-swap
 * that silently did not take is worse than no hot-swap: the session keeps
 * burning the exhausted account while rotorcc reports a rotation. Three things
 * are pinned here and each one has cost this project a defect before:
 *
 *   - a swap that left the identity block behind is a FAILURE, not a success
 *     with a cosmetic flaw. That is the shape where the session runs on one
 *     account and every surface names another.
 *   - "the session made no request" is reported as `unobserved`, never as
 *     `verified`. Absence of an error is not evidence.
 *   - an authentication failure that was already in the transcript before the
 *     swap must not be read as one caused by it.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { AccountManager } from '../src/accounts/manager.js';
import { asSecret } from '../src/accounts/credentials.js';
import { RosterStore, emptyRoster } from '../src/accounts/roster.js';
import { AUTH_FAILURE_SIGNATURES, hotSwapAccount } from '../src/core/hotswap.js';
import type { Config } from '../src/config/schema.js';
import { cleanup, quietLogger, tempDir, testConfig } from './helpers.js';

const dirs: string[] = [];
afterEach(() => cleanup(...dirs.splice(0)));

function credential(marker: string): string {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: `access-${marker}`,
      refreshToken: `refresh-${marker}`,
      expiresAt: Date.now() + 3_600_000,
      scopes: ['user:inference'],
    },
  });
}

interface World {
  config: Config;
  manager: AccountManager;
  transcript: string;
  claudeHome: string;
}

async function world(overrides: Partial<Config['rotation']> = {}): Promise<World> {
  const root = tempDir('rotorcc-hotswap-');
  dirs.push(root);
  const claudeHome = join(root, 'claude');
  const accountsDir = join(root, 'accounts');
  mkdirSync(claudeHome, { recursive: true });
  mkdirSync(accountsDir, { recursive: true });

  const env: NodeJS.ProcessEnv = { HOME: root, CLAUDE_CONFIG_DIR: claudeHome };
  const manager = new AccountManager({ accountsDir, env });

  // Two managed accounts; slot 1 is live.
  const roster = new RosterStore(accountsDir);
  const table = emptyRoster();
  for (const [slot, email] of [
    [1, 'one@example.com'],
    [2, 'two@example.com'],
  ] as const) {
    await manager.credentials.writeStash(slot, email, asSecret(credential(`slot${slot}`)));
    manager.credentials.writeAccountIdentity(slot, email, {
      emailAddress: email,
      accountUuid: `uuid-${slot}`,
    });
    table.accounts[String(slot)] = {
      email,
      uuid: `uuid-${slot}`,
      organizationUuid: '',
      organizationName: '',
      added: new Date().toISOString(),
      alias: '',
      disabled: false,
      kind: 'oauth',
    };
  }
  table.activeSlot = 1;
  roster.write(table);

  writeFileSync(join(claudeHome, '.credentials.json'), credential('slot1'));
  writeFileSync(
    join(claudeHome, '.claude.json'),
    JSON.stringify({ oauthAccount: { emailAddress: 'one@example.com', accountUuid: 'uuid-1' } }),
  );

  const transcript = join(root, 'session.jsonl');
  writeFileSync(transcript, '{"type":"user"}\n');

  const config = testConfig({
    claudeHome,
    accountsDir,
    rotation: { enabled: true, mode: 'auto', hotswapVerifySeconds: 4, ...overrides },
  } as Partial<Config>);

  return { config, manager, transcript, claudeHome };
}

/** A clock and a sleeper that make the watch loop deterministic and instant. */
function fakeTime(): { sleep: (ms: number) => Promise<void>; now: () => number } {
  let clock = 0;
  return {
    sleep: (ms: number) => {
      clock += ms;
      return Promise.resolve();
    },
    now: () => clock,
  };
}

describe('hotSwapAccount', () => {
  it('swaps the live credential AND the identity block, and says the session kept working', async () => {
    const w = await world();
    const time = fakeTime();

    // The session writes to its transcript during the watch: it made requests
    // across the swap and none of them failed.
    let writes = 0;
    const sleep = (ms: number): Promise<void> => {
      writes += 1;
      writeFileSync(w.transcript, `{"type":"assistant","n":${writes}}\n`, { flag: 'a' });
      return time.sleep(ms);
    };

    const result = await hotSwapAccount({
      config: w.config,
      logger: quietLogger,
      targetSlot: 2,
      transcriptPath: w.transcript,
      dryRun: false,
      manager: w.manager,
      sleep,
      now: time.now,
    });

    expect(result.verdict).toBe('verified');
    expect(result.credentialInPlace).toBe(true);
    expect(result.sessionMadeProgress).toBe(true);
    expect(result.authFailure).toBeNull();

    // The live credential is now slot 2's…
    const live = await w.manager.credentials.readActive();
    expect(live.kind).toBe('found');
    if (live.kind === 'found') expect(String(live.value)).toContain('slot2');
    // …and so is the identity block every surface reads.
    const identity = w.manager.credentials.readGlobalConfig()?.oauthAccount as {
      emailAddress?: string;
    };
    expect(identity.emailAddress).toBe('two@example.com');
  });

  it('reports "unobserved" when the session made no request, never "verified"', async () => {
    const w = await world();
    const time = fakeTime();

    const result = await hotSwapAccount({
      config: w.config,
      logger: quietLogger,
      targetSlot: 2,
      transcriptPath: w.transcript,
      dryRun: false,
      manager: w.manager,
      sleep: time.sleep,
      now: time.now,
    });

    expect(result.verdict).toBe('unobserved');
    expect(result.credentialInPlace).toBe(true);
    expect(result.sessionMadeProgress).toBe(false);
    expect(result.detail).toContain('nothing confirms it picked the new credential up');
  });

  it('fails when the live session reports an authentication failure after the swap', async () => {
    const w = await world();
    const time = fakeTime();
    let ticks = 0;
    const sleep = (ms: number): Promise<void> => {
      ticks += 1;
      if (ticks === 2) {
        writeFileSync(w.transcript, '{"text":"Login expired · Please run /login"}\n', {
          flag: 'a',
        });
      }
      return time.sleep(ms);
    };

    const result = await hotSwapAccount({
      config: w.config,
      logger: quietLogger,
      targetSlot: 2,
      transcriptPath: w.transcript,
      dryRun: false,
      manager: w.manager,
      sleep,
      now: time.now,
    });

    expect(result.verdict).toBe('failed');
    expect(result.authFailure).toBe('Login expired');
    expect(result.detail).toContain('NOT running on slot 2');
  });

  it('ignores an old authentication failure in a transcript far larger than any tail window', async () => {
    const w = await world();
    // The real shape: a long session. An hour-old failure, then megabytes of
    // ordinary work on top of it.
    //
    // A watch that compares TAILS rather than offsets breaks exactly here: the
    // window slides as the session appends, the new tail no longer starts with
    // the old one, the whole window reads as "fresh", and this old line is
    // re-found. In `auto` that replaces a live, working session.
    writeFileSync(w.transcript, '{"text":"Login expired · Please run /login"}\n', { flag: 'a' });
    writeFileSync(w.transcript, `{"filler":"${'x'.repeat(200_000)}"}\n`, { flag: 'a' });
    const time = fakeTime();
    let ticks = 0;
    const sleep = (ms: number): Promise<void> => {
      ticks += 1;
      // The session keeps working across the swap, sliding the window.
      writeFileSync(w.transcript, `{"filler":"${'y'.repeat(100_000)}","n":${ticks}}\n`, {
        flag: 'a',
      });
      return time.sleep(ms);
    };

    const result = await hotSwapAccount({
      config: w.config,
      logger: quietLogger,
      targetSlot: 2,
      transcriptPath: w.transcript,
      dryRun: false,
      manager: w.manager,
      sleep,
      now: time.now,
    });

    expect(result.verdict).toBe('verified');
    expect(result.authFailure).toBeNull();
  });

  it('ignores an authentication failure that was already in the transcript', async () => {
    const w = await world();
    // An hour-old failure the operator has already dealt with.
    writeFileSync(w.transcript, '{"text":"Login expired · Please run /login"}\n', { flag: 'a' });
    const time = fakeTime();

    const result = await hotSwapAccount({
      config: w.config,
      logger: quietLogger,
      targetSlot: 2,
      transcriptPath: w.transcript,
      dryRun: false,
      manager: w.manager,
      sleep: time.sleep,
      now: time.now,
    });

    expect(result.verdict).not.toBe('failed');
    expect(result.authFailure).toBeNull();
  });

  it('warns, loudly, when the target has no stored identity to move', async () => {
    const w = await world();
    // Nothing was ever captured for slot 2's identity, so there is no block to
    // install and no expectation to check it against. rotorcc cannot call that
    // a mismatch — but it must not stay quiet either: until this account is
    // captured, every surface keeps naming the account being left.
    w.manager.credentials.deleteAccountIdentity(2, 'two@example.com');
    const time = fakeTime();

    const result = await hotSwapAccount({
      config: w.config,
      logger: quietLogger,
      targetSlot: 2,
      transcriptPath: w.transcript,
      dryRun: false,
      manager: w.manager,
      sleep: time.sleep,
      now: time.now,
    });

    expect(result.verdict).not.toBe('failed');
    expect(result.warnings.join(' ')).toContain('no stored account identity');
  });

  it('fails when the identity block names an account other than the target', async () => {
    const w = await world();
    const time = fakeTime();

    // Simulate the half-swap this project is prone to: the credential moved,
    // and something put the identity block back to the account being left. The
    // session is on two@ and every surface would say one@.
    const original = w.manager.credentials.writeAccountIdentity.bind(w.manager.credentials);
    let switchDone = false;
    w.manager.credentials.writeAccountIdentity = (slot, email, identity): void => {
      original(slot, email, identity);
      switchDone = true;
    };
    const originalUpdate = w.manager.credentials.updateGlobalConfig.bind(w.manager.credentials);
    w.manager.credentials.updateGlobalConfig = (mutate): void => {
      originalUpdate(mutate);
      if (switchDone) {
        originalUpdate((config) => {
          config.oauthAccount = { emailAddress: 'one@example.com', accountUuid: 'uuid-1' };
        });
      }
    };

    const result = await hotSwapAccount({
      config: w.config,
      logger: quietLogger,
      targetSlot: 2,
      transcriptPath: w.transcript,
      dryRun: false,
      manager: w.manager,
      sleep: time.sleep,
      now: time.now,
    });

    expect(result.verdict).toBe('failed');
    expect(result.detail).toContain('identity block still names a different account');
  });

  it('refuses a slot that is not in the roster, and changes nothing', async () => {
    const w = await world();
    const before = await w.manager.credentials.readActive();

    const result = await hotSwapAccount({
      config: w.config,
      logger: quietLogger,
      targetSlot: 9,
      dryRun: false,
      manager: w.manager,
    });

    expect(result.verdict).toBe('failed');
    expect(result.detail).toContain("not in rotorcc's roster");
    const after = await w.manager.credentials.readActive();
    expect(after.kind === 'found' && before.kind === 'found' ? after.value : null).toBe(
      before.kind === 'found' ? before.value : undefined,
    );
  });

  it('writes nothing under --dry-run', async () => {
    const w = await world();
    const result = await hotSwapAccount({
      config: w.config,
      logger: quietLogger,
      targetSlot: 2,
      transcriptPath: w.transcript,
      dryRun: true,
      manager: w.manager,
    });

    expect(result.detail).toContain('DRY RUN');
    const live = await w.manager.credentials.readActive();
    expect(live.kind === 'found' ? String(live.value) : '').toContain('slot1');
  });

  it('skips the watch entirely when it is configured off', async () => {
    const w = await world({ hotswapVerifySeconds: 0 });
    let slept = 0;

    const result = await hotSwapAccount({
      config: w.config,
      logger: quietLogger,
      targetSlot: 2,
      transcriptPath: w.transcript,
      dryRun: false,
      manager: w.manager,
      sleep: () => {
        slept += 1;
        return Promise.resolve();
      },
    });

    expect(slept).toBe(0);
    expect(result.verdict).toBe('unobserved');
    expect(result.credentialInPlace).toBe(true);
  });

  it('knows the signature Claude Code actually prints', () => {
    // Observed on 2026-08-19 against v2.1.235 by swapping in a dead token: the
    // next turn answered "Login expired · Please run /login".
    expect(AUTH_FAILURE_SIGNATURES).toContain('Login expired');
    expect(AUTH_FAILURE_SIGNATURES).toContain('Please run /login');
  });
});
