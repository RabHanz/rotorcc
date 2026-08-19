/**
 * The pending account: which account the NEXT session should open on.
 *
 * This is the answer to the question that broke the old design. The Director
 * asked: *how does rotorcc stop a running session when the account nears its
 * limit?* The honest answer is that it cannot. A live Claude Code process reads
 * its credential once, at launch. There is no hot-swap. So the old model —
 * checkpoint, switch the credential, spawn a fresh `claude --continue` — was
 * **abandon and replace**, and on 2026-08-19 that produced two live sessions
 * sharing one worktree, which is corruption rather than resumption.
 *
 * The redesign inverts it. Rotation stops being an interruption and becomes a
 * *decision recorded for the next session start*:
 *
 *   - The watcher and the live hooks NEVER switch the account under a running
 *     session. They warn, they checkpoint, and they record an intent here.
 *   - `SessionStart` reads that intent and switches BEFORE the session begins.
 *     Zero interruption, no successor, no possibility of a duplicate.
 *   - A successor is launched only for a session that is genuinely dead.
 *
 * The file is small and boring on purpose: it is a single fact, written by
 * whoever notices first and consumed exactly once by the next session start.
 * Consuming it is what makes it impossible to act on twice — the third
 * production defect in this project's history was a stale flag being obeyed
 * hours after it stopped being true.
 */
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';

import { writeJsonAtomic } from '../accounts/atomic.js';

const pendingSchema = z.object({
  version: z.literal(1).default(1),
  /** The slot the next session should open on. */
  slot: z.number().int(),
  /** Human-readable, for the log and the dashboard. */
  reason: z.string(),
  /** When this intent was formed. */
  decidedAt: z.string(),
  /**
   * Past this, the intent is discarded unread.
   *
   * A rotation intent is about a quota picture that was true when it was
   * formed. Windows reset; an intent that survives a reset is describing a
   * world that no longer exists, and rotorcc has already shipped one defect
   * where exactly that got obeyed.
   */
  expiresAt: z.string(),
  /** Headroom on the account being left, when it was known. Null otherwise. */
  fromHeadroomPct: z.number().nullable().default(null),
  /** Which window drove the decision: `7d`, `5h`, or a model name. */
  window: z.string().default('unknown'),
  /** True when a dry run formed this. Such an intent is never acted on. */
  dryRun: z.boolean().default(false),
});

export type PendingSwitch = z.infer<typeof pendingSchema>;

/** How long an unconsumed intent stays valid. */
export const PENDING_TTL_MS = 6 * 3_600_000;

export class PendingSwitchStore {
  readonly path: string;

  constructor(stateDir: string) {
    this.path = join(stateDir, 'next-session-account.json');
  }

  /**
   * Record which account the next session should open on.
   *
   * Idempotent by design: recording the same target twice is a no-op in effect,
   * and recording a different one simply replaces it — the most recent read of
   * the quota picture is the one worth acting on.
   */
  record(intent: Omit<PendingSwitch, 'version' | 'expiresAt'> & { expiresAt?: string }): void {
    const decidedAt = Date.parse(intent.decidedAt);
    writeJsonAtomic(this.path, {
      version: 1,
      ...intent,
      expiresAt:
        intent.expiresAt ??
        new Date((Number.isNaN(decidedAt) ? Date.now() : decidedAt) + PENDING_TTL_MS).toISOString(),
    });
  }

  /** Read without consuming. For `status`, the TUI and `doctor`. */
  peek(): PendingSwitch | null {
    if (!existsSync(this.path)) return null;
    try {
      const parsed = pendingSchema.safeParse(JSON.parse(readFileSync(this.path, 'utf8')));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  /**
   * Read and CONSUME the intent, if it is still valid.
   *
   * The delete happens whether or not the intent was still valid, because an
   * expired intent left on disk is an expired instruction waiting for a reader
   * that forgets to check. Returns null for an expired or dry-run intent, with
   * the reason available via `peek` beforehand if a caller wants to log it.
   */
  consume(nowMs = Date.now()): PendingSwitch | null {
    const pending = this.peek();
    this.clear();
    if (pending === null) return null;
    if (pending.dryRun) return null;
    const expires = Date.parse(pending.expiresAt);
    if (!Number.isNaN(expires) && nowMs >= expires) return null;
    return pending;
  }

  clear(): boolean {
    try {
      if (!existsSync(this.path)) return false;
      unlinkSync(this.path);
      return true;
    } catch {
      return false;
    }
  }
}
