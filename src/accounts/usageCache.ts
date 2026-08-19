/**
 * The usage cache: last-good quota per account, with its age attached.
 *
 * Two jobs, and the second matters more than the first.
 *
 * 1. **Do not hammer the endpoint.** The watcher ticks every 60 seconds and the
 *    TUI redraws every second; without a cache that is one API call per account
 *    per redraw. The usage endpoint has a budget and saturating it returns 429,
 *    at which point rotorcc knows nothing about any account — the exact failure
 *    it exists to prevent.
 *
 * 2. **Serve stale data as stale, never as current.** Every entry carries the
 *    moment it was measured and the outcome of the most recent attempt. A caller
 *    can then say "91% headroom, measured 4 minutes ago" or "unknown since the
 *    last three reads failed", and never "91%" full stop when the number is an
 *    hour old. An unknown is a `null`, all the way through; there is no code
 *    path in this file that turns a failed read into a percentage.
 *
 * The cache file holds no credential — only percentages, reset times and error
 * kinds — so it is safe to read while diagnosing.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';

import { ensurePrivateDir, writeJsonAtomic } from './atomic.js';
import type { UsageFetchError, UsageWindow } from './oauth.js';

/**
 * Do not re-poll one account more often than this. Chosen against the
 * endpoint's observed budget rather than against how fresh we would like the
 * number: three minutes of staleness on a five-hour window is under one
 * percent of it, and a 429 costs far more than three minutes of lag.
 */
export const MIN_POLL_INTERVAL_MS = 180_000;
/** Past this, an entry is old enough that its age must be shown, not implied. */
export const STALE_AFTER_MS = 600_000;
/** Past this, the entry stops being served as a number at all. */
export const EXPIRED_AFTER_MS = 6 * 3_600_000;

const windowSchema = z.object({
  name: z.string(),
  usedPct: z.number(),
  resetsAt: z.string().nullish(),
});

const entrySchema = z.object({
  /** Windows from the last SUCCESSFUL read. Null when there has never been one. */
  windows: z.array(windowSchema).nullish(),
  /** ISO time of that successful read. Null when there has never been one. */
  fetchedAt: z.string().nullish(),
  /** ISO time of the last attempt, successful or not. */
  attemptedAt: z.string().nullish(),
  /** Why the last attempt failed, as a short stable token. Null on success. */
  lastError: z.string().nullish(),
  /** Consecutive failures. Reset to zero by any success. */
  consecutiveFailures: z.number().int().nonnegative().default(0),
  /** Do not attempt again before this ISO time (honours server Retry-After). */
  backoffUntil: z.string().nullish(),
});

const cacheSchema = z.object({
  version: z.literal(1).default(1),
  /** Keyed by slot number as a string. */
  accounts: z.record(z.string(), entrySchema).default({}),
});

export type UsageCacheEntry = z.infer<typeof entrySchema>;
export type UsageCacheFile = z.infer<typeof cacheSchema>;

/** How an entry should be presented, decided once so every surface agrees. */
export type Freshness =
  | { kind: 'fresh'; ageMs: number }
  | { kind: 'stale'; ageMs: number }
  | { kind: 'expired'; ageMs: number }
  | { kind: 'never-read' };

export function freshnessOf(entry: UsageCacheEntry | undefined, nowMs = Date.now()): Freshness {
  if (entry?.fetchedAt === null || entry?.fetchedAt === undefined) return { kind: 'never-read' };
  const at = Date.parse(entry.fetchedAt);
  if (Number.isNaN(at)) return { kind: 'never-read' };
  const ageMs = Math.max(0, nowMs - at);
  if (ageMs > EXPIRED_AFTER_MS) return { kind: 'expired', ageMs };
  if (ageMs > STALE_AFTER_MS) return { kind: 'stale', ageMs };
  return { kind: 'fresh', ageMs };
}

/** A short, stable, loggable token for a fetch failure. Never carries a token. */
export function errorToken(error: UsageFetchError): string {
  switch (error.kind) {
    case 'http':
      return `http-${error.status}`;
    case 'timeout':
      return 'timeout';
    case 'network':
      return 'network';
    case 'bad-response':
      return 'bad-response';
    case 'unauthorised':
      return 'unauthorised';
  }
}

export class UsageCache {
  readonly path: string;

  constructor(readonly accountsDir: string) {
    this.path = join(accountsDir, 'usage-cache.json');
  }

  read(): UsageCacheFile {
    if (!existsSync(this.path)) return { version: 1, accounts: {} };
    try {
      const parsed = cacheSchema.safeParse(JSON.parse(readFileSync(this.path, 'utf8')));
      // A cache that does not parse is discarded rather than thrown over. It is
      // a cache: losing it costs one round of API calls, and refusing to start
      // because a derived file went bad would be the tool failing closed again.
      return parsed.success ? parsed.data : { version: 1, accounts: {} };
    } catch {
      return { version: 1, accounts: {} };
    }
  }

  write(cache: UsageCacheFile): void {
    ensurePrivateDir(this.accountsDir);
    writeJsonAtomic(this.path, cache);
  }

  entry(slot: number): UsageCacheEntry | undefined {
    return this.read().accounts[String(slot)];
  }

  /** Record a successful read, clearing failure state. */
  recordSuccess(slot: number, windows: UsageWindow[], fetchedAt: string): void {
    const cache = this.read();
    cache.accounts[String(slot)] = {
      windows,
      fetchedAt,
      attemptedAt: fetchedAt,
      lastError: null,
      consecutiveFailures: 0,
      backoffUntil: null,
    };
    this.write(cache);
  }

  /**
   * Record a failure, keeping the last-good windows.
   *
   * Keeping them is the point: an account that read fine four minutes ago and
   * has failed once since is far better described as "45%, four minutes old"
   * than as "unknown". The caller decides at what age that stops being true —
   * `freshnessOf` gives it the age to decide with.
   *
   * Backoff is exponential from the poll floor, capped, and yields to the
   * server's `Retry-After` whenever it sent one.
   */
  recordFailure(slot: number, error: UsageFetchError, nowMs = Date.now()): void {
    const cache = this.read();
    const key = String(slot);
    const previous = cache.accounts[key];
    const failures = (previous?.consecutiveFailures ?? 0) + 1;
    const serverRetryMs =
      error.kind === 'http' && error.retryAfterSeconds !== null
        ? error.retryAfterSeconds * 1000
        : null;
    const backoffMs =
      serverRetryMs ?? Math.min(30 * 60_000, MIN_POLL_INTERVAL_MS * 2 ** Math.min(failures - 1, 5));
    cache.accounts[key] = {
      windows: previous?.windows ?? null,
      fetchedAt: previous?.fetchedAt ?? null,
      attemptedAt: new Date(nowMs).toISOString(),
      lastError: errorToken(error),
      consecutiveFailures: failures,
      backoffUntil: new Date(nowMs + backoffMs).toISOString(),
    };
    this.write(cache);
  }

  /**
   * Whether this slot may be polled right now.
   *
   * `force` skips the poll floor but never the backoff: an operator asking for
   * a refresh deserves one, and hammering an endpoint that just returned 429
   * still helps nobody.
   */
  mayPoll(slot: number, options: { force?: boolean; nowMs?: number } = {}): boolean {
    const nowMs = options.nowMs ?? Date.now();
    const entry = this.entry(slot);
    if (entry === undefined) return true;

    if (entry.backoffUntil !== null && entry.backoffUntil !== undefined) {
      const until = Date.parse(entry.backoffUntil);
      if (!Number.isNaN(until) && nowMs < until) return false;
    }
    if (options.force === true) return true;

    const attempted = entry.attemptedAt;
    if (attempted === null || attempted === undefined) return true;
    const at = Date.parse(attempted);
    if (Number.isNaN(at)) return true;
    return nowMs - at >= MIN_POLL_INTERVAL_MS;
  }

  forget(slot: number): void {
    const cache = this.read();
    delete cache.accounts[String(slot)];
    this.write(cache);
  }
}
