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
}

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

  raiseFlag(name: string, payload: FlagPayload): string {
    this.ensure();
    return this.writeAtomic(join('flags', name), `${JSON.stringify(payload, null, 2)}\n`);
  }

  readFlag(name: string): FlagPayload | null {
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
   * on, where an O_EXCL file is not reliably so over network mounts. A lock
   * older than `staleSeconds` is broken, because the holder was killed.
   */
  acquireLock(name: string, staleSeconds = 600): boolean {
    const dir = this.path('locks', name);
    mkdirSync(this.path('locks'), { recursive: true });
    try {
      mkdirSync(dir);
    } catch {
      try {
        const age = (Date.now() - statSync(dir).mtimeMs) / 1000;
        if (age < staleSeconds) return false;
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

/** `2026-08-18T01-23-45-678Z`: sortable, and legal as a filename everywhere. */
export function timestampSlug(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, '-');
}
