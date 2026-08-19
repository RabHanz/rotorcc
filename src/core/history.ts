/**
 * The decision journal: what rotorcc decided, when, and why.
 *
 * This exists because of a specific failure. On 2026-08-19 the watcher ticked
 * every sixty seconds for hours while an operator burned to 99%, and there was
 * no record anywhere of what it had decided on any of those ticks. The log had
 * warnings; nothing had "considered rotating, refused, here is the reason".
 * With this file, `rotorcc tui` and `rotorcc status` can show the last N
 * decisions and an operator can see at a glance that the tool has been
 * deciding "do nothing" two hundred times in a row and why.
 *
 * A refusal is recorded exactly as loudly as a rotation. That is the whole
 * point: the failure mode is not the wrong action, it is the confident absence
 * of one.
 *
 * Contains no credentials — account numbers, percentages and reasons only — so
 * it is safe to paste into a bug report.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';

import { writeJsonAtomic } from '../accounts/atomic.js';

export const decisionKinds = [
  'rotated',
  'refused',
  'checkpointed',
  'warned',
  'idle',
  'blocked',
  'error',
] as const;

const entrySchema = z.object({
  at: z.string(),
  kind: z.enum(decisionKinds),
  /** The account that was active when this was decided. */
  activeAccount: z.number().nullable().default(null),
  /** Where it went, for a rotation. Null otherwise. */
  targetAccount: z.number().nullable().default(null),
  /** Active account's headroom, or null when it was not known. */
  headroomPct: z.number().nullable().default(null),
  bindingWindow: z.string().default('unknown'),
  /** The full reason, in the words the decision function used. */
  reason: z.string(),
  /** Which strategy produced it, when a target was being chosen. */
  strategy: z.string().nullable().default(null),
  /** True when this ran under --dry-run. Rendered unmistakably. */
  dryRun: z.boolean().default(false),
  /** Trees that were unsaved at the moment of the decision. */
  unsavedTrees: z.number().nullable().default(null),
});

const journalSchema = z.object({
  version: z.literal(1).default(1),
  entries: z.array(entrySchema).default([]),
});

export type DecisionEntry = z.infer<typeof entrySchema>;
export type Journal = z.infer<typeof journalSchema>;

/**
 * How many decisions to keep.
 *
 * At a 60-second tick that is about four hours of history — long enough to
 * cover a shift, short enough that the file stays small and the atomic rewrite
 * on every tick stays cheap.
 */
export const MAX_ENTRIES = 240;

export class DecisionJournal {
  readonly path: string;

  constructor(stateDir: string) {
    this.path = join(stateDir, 'decisions.json');
  }

  read(): Journal {
    if (!existsSync(this.path)) return { version: 1, entries: [] };
    try {
      const parsed = journalSchema.safeParse(JSON.parse(readFileSync(this.path, 'utf8')));
      return parsed.success ? parsed.data : { version: 1, entries: [] };
    } catch {
      return { version: 1, entries: [] };
    }
  }

  /** Append one decision. Newest is last in the file, first in `recent()`. */
  record(entry: Omit<DecisionEntry, 'at'> & { at?: string }): void {
    const journal = this.read();
    journal.entries.push({
      ...entry,
      at: entry.at ?? new Date().toISOString(),
    });
    if (journal.entries.length > MAX_ENTRIES) {
      journal.entries = journal.entries.slice(-MAX_ENTRIES);
    }
    writeJsonAtomic(this.path, journal);
  }

  /** The most recent `count` decisions, newest first. */
  recent(count = 10): DecisionEntry[] {
    return this.read().entries.slice(-count).reverse();
  }

  /**
   * The most recent decision that actually did something.
   *
   * A screen full of "idle" is exactly what an operator does not need to read
   * through to find the last real event.
   */
  lastAction(): DecisionEntry | null {
    const entries = this.read().entries;
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const entry = entries[i] as DecisionEntry;
      if (entry.kind !== 'idle') return entry;
    }
    return null;
  }

  /**
   * How long rotorcc has been deciding to do nothing, in consecutive ticks.
   *
   * Surfaced because a long run of idle decisions is either completely normal
   * or the exact shape of the 2026-08-19 defect, and only the operator looking
   * at the headroom beside it can tell which.
   */
  consecutiveIdle(): number {
    const entries = this.read().entries;
    let count = 0;
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      if ((entries[i] as DecisionEntry).kind !== 'idle') break;
      count += 1;
    }
    return count;
  }
}
