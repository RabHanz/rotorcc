/**
 * Durable state: latches, flags, manifests, and the lock that keeps the daemon
 * and a hook from checkpointing the same tree at the same moment.
 *
 * Writes are atomic (temp file, then rename) because the daemon can be killed
 * at any instant — including by the same account exhaustion it is watching for
 * — and a half-written latch file that fails to parse would re-arm every alarm.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { type RotorState, emptyState } from './decide.js';

export const FLAG_SOFT_CHECKPOINT = 'SOFT_CHECKPOINT_REQUESTED';
export const FLAG_ROTATE_NOW = 'ROTATE_NOW';

export interface FlagPayload {
  raisedAt: string;
  reason: string;
  manifestPath?: string;
  manifestMarkdownPath?: string;
  targetAccount?: number;
  headroomPct?: number;
  /**
   * The severity level that was true when this was raised.
   *
   * Recorded so a reader can cross-check the flag against reality instead of
   * obeying it on faith. On 2026-08-18 a `ROTATE_NOW` left behind by a dry run
   * was surfaced to a healthy live session hours later — 72% headroom, rotation
   * disabled — and told the orchestrator to exit. A flag that carries the level
   * it was raised at can be discarded the moment that level stops holding.
   */
  level?: string;
  /**
   * ISO time past which this flag means nothing.
   *
   * A rotation signal is about right now. One that survives on disk for hours
   * is not stale information, it is wrong information, and it is read as an
   * instruction. `readFlag` refuses to return an expired flag.
   */
  expiresAt?: string;
  /** True when a dry run produced this. Such a flag is never an instruction. */
  dryRun?: boolean;
}

/** Default life of a raised flag. Past this it is discarded, not obeyed. */
export const FLAG_TTL_MS = 30 * 60_000;

export class Store {
  constructor(readonly dir: string) {}

  private path(...parts: string[]): string {
    return join(this.dir, ...parts);
  }

  ensure(): void {
    mkdirSync(this.path('manifests'), { recursive: true });
    mkdirSync(this.path('flags'), { recursive: true });
  }

  writeAtomic(relative: string, contents: string): string {
    const target = this.path(relative);
    mkdirSync(join(target, '..'), { recursive: true });
    const temp = `${target}.tmp-${process.pid}`;
    writeFileSync(temp, contents, 'utf8');
    renameSync(temp, target);
    return target;
  }

  readState(): RotorState {
    try {
      const parsed = JSON.parse(readFileSync(this.path('state.json'), 'utf8')) as RotorState;
      if (parsed.version !== 1) return emptyState();
      return { ...emptyState(), ...parsed };
    } catch {
      return emptyState();
    }
  }

  writeState(state: RotorState): void {
    this.ensure();
    this.writeAtomic('state.json', `${JSON.stringify(state, null, 2)}\n`);
  }

  /**
   * Raise a flag.
   *
   * `expiresAt` is filled in when the caller did not supply one, so there is no
   * way to raise a flag that lives forever — the default is the safe one and
   * forgetting it is not possible.
   */
  raiseFlag(name: string, payload: FlagPayload, ttlMs = FLAG_TTL_MS): string {
    this.ensure();
    const raisedAt = payload.raisedAt;
    const expiresAt =
      payload.expiresAt ??
      new Date((Number.isNaN(Date.parse(raisedAt)) ? Date.now() : Date.parse(raisedAt)) + ttlMs)
        .toISOString();
    return this.writeAtomic(
      join('flags', name),
      `${JSON.stringify({ ...payload, expiresAt }, null, 2)}\n`,
    );
  }

  /**
   * Read a flag, discarding one that has expired or that a dry run wrote.
   *
   * The deletion is deliberate and not merely a filter. A flag on disk gets
   * read by the next process too, and by a human looking at the state
   * directory; leaving an expired one there to be ignored six more times is
   * how it eventually gets obeyed by whichever reader forgot to check.
   *
   * `currentLevel`, when supplied, is cross-checked against the level the flag
   * was raised at. A `ROTATE_NOW` raised at `rotate` while the account now
   * reads `ok` is describing a world that no longer exists.
   */
  readFlag(name: string, options: { nowMs?: number; currentLevel?: string } = {}): FlagPayload | null {
    let payload: FlagPayload;
    try {
      payload = JSON.parse(readFileSync(this.path('flags', name), 'utf8')) as FlagPayload;
    } catch {
      return null;
    }

    const nowMs = options.nowMs ?? Date.now();

    if (payload.dryRun === true) {
      this.clearFlag(name);
      return null;
    }

    if (payload.expiresAt !== undefined) {
      const expires = Date.parse(payload.expiresAt);
      if (!Number.isNaN(expires) && nowMs >= expires) {
        this.clearFlag(name);
        return null;
      }
    }

    if (
      options.currentLevel !== undefined &&
      payload.level !== undefined &&
      !levelStillHolds(payload.level, options.currentLevel)
    ) {
      this.clearFlag(name);
      return null;
    }

    return payload;
  }

  /** The raw flag, expiry and all. For diagnostics only — never for a decision. */
  peekFlag(name: string): FlagPayload | null {
    try {
      return JSON.parse(readFileSync(this.path('flags', name), 'utf8')) as FlagPayload;
    } catch {
      return null;
    }
  }

  clearFlag(name: string): boolean {
    try {
      unlinkSync(this.path('flags', name));
      return true;
    } catch {
      return false;
    }
  }

  manifestDir(): string {
    this.ensure();
    return this.path('manifests');
  }

  listManifests(): string[] {
    try {
      return readdirSync(this.manifestDir())
        .filter((f) => f.startsWith('manifest-') && f.endsWith('.json'))
        .sort()
        .reverse()
        .map((f) => this.path('manifests', f));
    } catch {
      return [];
    }
  }

  latestManifest(): string | null {
    return this.listManifests()[0] ?? null;
  }

  /**
   * A directory-based lock: `mkdir` is atomic on every filesystem rotorcc runs
   * on, where an O_EXCL file is not reliably so over network mounts.
   *
   * A held lock is broken in two cases: the owning process is gone, or the lock
   * is older than `staleSeconds`. The liveness check matters more than the
   * timeout — a killed holder would otherwise block every checkpoint for the
   * whole stale window, which is precisely the moment work most needs saving.
   */
  acquireLock(name: string, staleSeconds = 600): boolean {
    const dir = this.path('locks', name);
    mkdirSync(this.path('locks'), { recursive: true });
    try {
      mkdirSync(dir);
    } catch {
      if (!this.lockIsDead(dir, staleSeconds)) return false;
      try {
        rmSync(dir, { recursive: true, force: true });
        mkdirSync(dir);
      } catch {
        return false;
      }
    }
    try {
      writeFileSync(join(dir, 'owner'), `${process.pid}\n${new Date().toISOString()}\n`, 'utf8');
    } catch {
      /* the lock is the directory; the owner note is a courtesy */
    }
    return true;
  }

  private lockIsDead(dir: string, staleSeconds: number): boolean {
    try {
      // Clamped at zero: a filesystem mtime can read a hair ahead of
      // `Date.now()` (different clock sources, different rounding), and a
      // negative age made a zero stale window fail to expire anything.
      const age = Math.max(0, (Date.now() - statSync(dir).mtimeMs) / 1000);
      if (age >= staleSeconds) return true;
    } catch {
      return true;
    }
    try {
      const pid = Number.parseInt(
        readFileSync(join(dir, 'owner'), 'utf8').split('\n')[0] ?? '',
        10,
      );
      if (!Number.isFinite(pid) || pid <= 0) return false;
      if (pid === process.pid) return false;
      // Signal 0 tests for existence without touching the process. ESRCH means
      // the owner is gone; EPERM means it exists and belongs to someone else.
      process.kill(pid, 0);
      return false;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'ESRCH';
    }
  }

  releaseLock(name: string): void {
    try {
      rmSync(this.path('locks', name), { recursive: true, force: true });
    } catch {
      /* already gone */
    }
  }

  exists(relative: string): boolean {
    return existsSync(this.path(relative));
  }

  absolute(relative: string): string {
    return this.path(relative);
  }
}

/**
 * Whether a flag raised at `raised` still holds now that the level is `current`.
 *
 * Ordered by severity: a flag survives while things are at least as bad as when
 * it was raised. Recovery clears it. An unrecognised level errs toward keeping
 * the flag — dropping a real rotation signal because of a spelling we did not
 * expect would be the more expensive mistake.
 */
export function levelStillHolds(raised: string, current: string): boolean {
  const order = ['ok', 'warn', 'soft', 'rotate'];
  const raisedRank = order.indexOf(raised);
  const currentRank = order.indexOf(current);
  if (raisedRank === -1 || currentRank === -1) return true;
  return currentRank >= raisedRank;
}

/** `2026-08-18T01-23-45-678Z`: sortable, and legal as a filename everywhere. */
export function timestampSlug(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, '-');
}
