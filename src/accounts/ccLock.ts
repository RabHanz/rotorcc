/**
 * Cooperating with Claude Code's own advisory locks while we mutate its files.
 *
 * This is the module that decides whether a rotation can corrupt a live
 * session, so the protocol is written down rather than assumed.
 *
 * Claude Code guards its OAuth refresh and its `~/.claude.json` writes with
 * npm's `proper-lockfile`. The parts that bind us:
 *
 *   - The lock artefact is a DIRECTORY. `mkdir` is the mutex, because it is
 *     atomic on every filesystem including network mounts, where an O_EXCL file
 *     is not reliably so.
 *   - The refresh path takes TWO locks, in this order: the primary
 *     `<config-home>/.oauth_refresh.lock`, then the legacy `~/.claude.lock`.
 *     Taking them in the same order is what makes a waiting rotorcc and a
 *     waiting Claude Code unable to deadlock against each other.
 *   - Credential locks are stale only after 60s and are touched every 5s by a
 *     live holder. The config lock uses proper-lockfile's older defaults: stale
 *     after 10s, touched every 5s.
 *
 * Why hold them at all: Claude Code's refresh reads the credential, refreshes
 * it over the network, and saves — all inside these locks. A swap landing in
 * that window is overwritten by the refreshed OLD account's token, and the
 * backup rotorcc just took holds a refresh token that has already been spent.
 * Under the lock, Claude Code's own re-read sees the swapped credential and
 * abandons the refresh instead. This is the difference between a rotation and
 * a corrupted login.
 *
 * NEVER lower the staleness. A 60s window looks generous until you remember the
 * holder may be a laptop that just came out of suspend: stealing a lock a live
 * Claude Code still owns is precisely the corruption this module prevents.
 *
 * The lock protocol here is a re-implementation of the behaviour claude-swap
 * (MIT, Onur Cetinkol) documented from the Claude Code 2.1.218 bundle. See
 * THIRD-PARTY-NOTICES.md.
 */
import { mkdirSync, rmdirSync, statSync, utimesSync } from 'node:fs';
import { join } from 'node:path';

import { claudeConfigHome, claudeGlobalConfigPath } from '../core/paths.js';

/** Claude Code's credential locks: stale only past 60 seconds. */
export const CREDENTIALS_STALE_MS = 60_000;
/** Claude Code's config lock keeps proper-lockfile's older 10s default. */
export const CONFIG_STALE_MS = 10_000;
/** We touch faster than Claude Code's 5s, for margin. */
export const TOUCH_INTERVAL_MS = 3_000;
/**
 * Per-lock acquisition budget. Claude Code holds the credential lock for one
 * token-endpoint round trip and the config lock for a local read-modify-write,
 * so nine seconds comfortably outlasts both. `claudeCredentialsLock` takes two
 * locks in sequence, so its worst case is about twice this.
 */
export const DEFAULT_LOCK_TIMEOUT_MS = 9_000;

export class LockTimeoutError extends Error {
  constructor(readonly lockDir: string) {
    super(
      `could not acquire ${lockDir} — Claude Code appears to be refreshing its ` +
        'credentials right now. Retry in a few seconds.',
    );
    this.name = 'LockTimeoutError';
  }
}

export function oauthRefreshLockDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(claudeConfigHome(env), '.oauth_refresh.lock');
}

/**
 * The legacy credential lock, `~/.claude.lock`: a sibling of the config home,
 * not a child of it. Claude Code still takes it for compatibility with outside
 * tools, and that compatibility is the only reason our exclusion holds.
 */
export function legacyCredentialsLockDir(env: NodeJS.ProcessEnv = process.env): string {
  return `${claudeConfigHome(env)}.lock`;
}

export function configLockDir(env: NodeJS.ProcessEnv = process.env): string {
  return `${claudeGlobalConfigPath(env)}.lock`;
}

export interface LockHandle {
  dir: string;
  release: () => void;
}

export interface AcquireOptions {
  timeoutMs?: number;
  staleMs?: number;
  /** Injected in tests so a lock protocol can be exercised without sleeping. */
  now?: () => number;
  /** Injected in tests. Real code busy-waits; see the note in `sleep`. */
  sleep?: (ms: number) => void;
}

function sleepBusy(ms: number): void {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    /* spin */
  }
}

/**
 * Acquire one proper-lockfile-compatible directory lock.
 *
 * Blocks up to `timeoutMs`, takes over a lock whose mtime is older than
 * `staleMs`, and touches the directory while held so another holder does not
 * deem US stale. The returned handle's `release` is idempotent.
 *
 * Synchronous on purpose. A credential swap is a sequence of steps that must
 * not interleave with anything, and an async lock invites a forgotten `await`
 * in the middle of exactly that sequence.
 */
export function acquireLock(lockDir: string, options: AcquireOptions = {}): LockHandle {
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const staleMs = options.staleMs ?? CONFIG_STALE_MS;
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? sleepBusy;

  const start = now();
  for (;;) {
    try {
      mkdirSync(lockDir, { recursive: false, mode: 0o700 });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }

    if (now() - start > timeoutMs) throw new LockTimeoutError(lockDir);

    let heldMtimeMs: number;
    try {
      heldMtimeMs = statSync(lockDir).mtimeMs;
    } catch {
      // The holder released between our mkdir and our stat. Retry immediately.
      continue;
    }
    // Clamped at zero: a filesystem mtime can read a hair ahead of the clock we
    // are comparing against (different sources, different rounding), and a
    // negative age would make a lock look infinitely fresh.
    const ageMs = Math.max(0, now() - heldMtimeMs);
    if (ageMs > staleMs) {
      try {
        rmdirSync(lockDir);
      } catch {
        // Cannot remove it either. Do not spin hot on a lock we cannot break.
        sleep(50);
      }
      continue;
    }
    // Jitter, so two waiters do not retry in lockstep forever.
    sleep(250 + Math.floor(Math.random() * 250));
  }

  const toucher = setInterval(() => {
    try {
      const stamp = new Date();
      utimesSync(lockDir, stamp, stamp);
    } catch {
      // The lock was stolen or removed under us. Nothing left to keep alive;
      // stop touching rather than logging once every three seconds forever.
      clearInterval(toucher);
    }
  }, TOUCH_INTERVAL_MS);
  // A held lock must never be the reason a CLI process refuses to exit.
  toucher.unref?.();

  let released = false;
  return {
    dir: lockDir,
    release(): void {
      if (released) return;
      released = true;
      clearInterval(toucher);
      try {
        rmdirSync(lockDir);
      } catch {
        /* already gone, or taken over as stale; nothing useful to do */
      }
    },
  };
}

/** Run `body` holding one lock, releasing it however `body` ends. */
export function withLock<T>(lockDir: string, options: AcquireOptions, body: () => T): T {
  const handle = acquireLock(lockDir, options);
  try {
    return body();
  } finally {
    handle.release();
  }
}

/**
 * Hold Claude Code's credential locks, in Claude Code's own order, for `body`.
 *
 * Both use the 60-second staleness. The order — primary refresh lock, then the
 * legacy one — is not a preference; reversing it is how two cooperating tools
 * deadlock.
 */
export async function withClaudeCredentialsLock<T>(
  body: () => Promise<T>,
  options: AcquireOptions & { env?: NodeJS.ProcessEnv } = {},
): Promise<T> {
  const env = options.env ?? process.env;
  const lockOptions: AcquireOptions = {
    ...options,
    staleMs: options.staleMs ?? CREDENTIALS_STALE_MS,
  };
  const primary = acquireLock(oauthRefreshLockDir(env), lockOptions);
  let legacy: LockHandle | null = null;
  try {
    legacy = acquireLock(legacyCredentialsLockDir(env), lockOptions);
    return await body();
  } finally {
    legacy?.release();
    primary.release();
  }
}

/** Hold Claude Code's global-config write lock for `body`. */
export async function withClaudeConfigLock<T>(
  body: () => Promise<T>,
  options: AcquireOptions & { env?: NodeJS.ProcessEnv } = {},
): Promise<T> {
  const env = options.env ?? process.env;
  const handle = acquireLock(configLockDir(env), {
    ...options,
    staleMs: options.staleMs ?? CONFIG_STALE_MS,
  });
  try {
    return await body();
  } finally {
    handle.release();
  }
}
