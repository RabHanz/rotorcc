/**
 * The roster: which accounts rotorcc manages, in which slots.
 *
 * Metadata only — no credential ever enters this file. That separation is the
 * reason the roster can be printed, diffed, backed up and pasted into an issue
 * while the credential store cannot.
 *
 * A slot number is the operator's handle for an account. It is stable across
 * removals (removing slot 2 does not renumber slot 3) because a number that
 * shifts under you is a number you cannot put in a script, a cron line or a
 * directory mapping.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';

import { ensurePrivateDir, writeJsonAtomic } from './atomic.js';

/**
 * An alias may not be purely numeric, or it could not be told apart from a slot
 * number when one is passed where the other is expected. It may not start with
 * `-`, or the CLI would read it as a flag and the alias would be unusable the
 * moment it was set.
 */
const ALIAS_PATTERN = /^[a-z0-9_.-]+$/;

export function normaliseAlias(name: string): string {
  const normalised = name.trim().toLowerCase();
  if (normalised === '') throw new Error('an alias cannot be empty');
  if (/^\d+$/.test(normalised)) {
    throw new Error(`alias "${name}" cannot be all digits — that is a slot number`);
  }
  if (normalised.startsWith('-')) {
    throw new Error(`alias "${name}" cannot start with "-" — it would be read as a flag`);
  }
  if (!ALIAS_PATTERN.test(normalised)) {
    throw new Error(`alias "${name}" may only contain letters, digits, "-", "_" and "."`);
  }
  return normalised;
}

export const accountEntrySchema = z.object({
  /** The login this slot holds. Also part of the credential stash filename. */
  email: z.string().min(1),
  /** Anthropic's account uuid, when known. Empty for a setup-token slot. */
  uuid: z.string().default(''),
  organizationUuid: z.string().default(''),
  organizationName: z.string().default(''),
  /** ISO time the slot was created. */
  added: z.string().default(''),
  alias: z.string().default(''),
  /**
   * Held out of AUTOMATIC rotation, but still a valid explicit target. An
   * operator disabling a slot is saying "do not send work here on your own",
   * not "I can never use this again" — conflating those makes `disable` a
   * thing people avoid using.
   */
  disabled: z.boolean().default(false),
  /**
   * `oauth` for a normal login, `api-key` for a managed key. API-key slots bill
   * per token, so they are never an automatic target unless explicitly allowed.
   */
  kind: z.enum(['oauth', 'api-key']).default('oauth'),
});

export const rosterSchema = z.object({
  version: z.literal(1).default(1),
  /** The slot rotorcc believes is live. Verified against the machine, never trusted alone. */
  activeSlot: z.number().int().nullable().default(null),
  lastUpdated: z.string().default(''),
  /** Slot number (as a string key, because JSON objects have string keys) to entry. */
  accounts: z.record(z.string(), accountEntrySchema).default({}),
});

export type AccountEntry = z.infer<typeof accountEntrySchema>;
export type Roster = z.infer<typeof rosterSchema>;

export function emptyRoster(): Roster {
  return { version: 1, activeSlot: null, lastUpdated: '', accounts: {} };
}

export interface RosterSlot extends AccountEntry {
  slot: number;
}

export class RosterStore {
  readonly path: string;

  constructor(readonly accountsDir: string) {
    this.path = join(accountsDir, 'roster.json');
  }

  /**
   * Read the roster.
   *
   * A missing file is an empty roster: rotorcc simply manages no accounts yet,
   * which is a legitimate state and not an error. A file that exists but does
   * NOT parse throws, because silently returning "no accounts" for a torn
   * roster is how the next write erases three real accounts.
   */
  read(): Roster {
    if (!existsSync(this.path)) return emptyRoster();
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.path, 'utf8'));
    } catch (err) {
      throw new Error(
        `${this.path} exists but is not valid JSON (${(err as Error).message.slice(0, 120)}). ` +
          'rotorcc will not overwrite it. Repair or move the file, then retry.',
      );
    }
    const parsed = rosterSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(
        `${this.path} is not a roster rotorcc understands: ${parsed.error.issues
          .slice(0, 3)
          .map((i) => `${i.path.join('.')} ${i.message}`)
          .join('; ')}`,
      );
    }
    return parsed.data;
  }

  write(roster: Roster): void {
    ensurePrivateDir(this.accountsDir);
    writeJsonAtomic(this.path, { ...roster, lastUpdated: new Date().toISOString() });
  }

  /** Read, mutate, write — the only safe way to change one field. */
  update(mutate: (roster: Roster) => void): Roster {
    const roster = this.read();
    mutate(roster);
    this.write(roster);
    return roster;
  }
}

/** Slots in ascending numeric order. JSON key order is not a sort. */
export function slots(roster: Roster): RosterSlot[] {
  return Object.entries(roster.accounts)
    .map(([key, entry]) => ({ ...entry, slot: Number.parseInt(key, 10) }))
    .filter((s) => Number.isInteger(s.slot))
    .sort((a, b) => a.slot - b.slot);
}

/** The lowest slot number not in use. */
export function nextFreeSlot(roster: Roster): number {
  const taken = new Set(slots(roster).map((s) => s.slot));
  let candidate = 1;
  while (taken.has(candidate)) candidate += 1;
  return candidate;
}

export type ResolveResult =
  | { kind: 'found'; slot: RosterSlot }
  | { kind: 'not-found' }
  | { kind: 'ambiguous'; matches: RosterSlot[] };

/**
 * Resolve `1`, `me@example.com` or `rabee` to a slot.
 *
 * Ambiguity is reported, never guessed. Two slots sharing an email is a real
 * state (the same login added twice by accident), and picking one silently
 * means a switch lands somewhere the operator did not choose.
 */
export function resolveIdentifier(roster: Roster, identifier: string): ResolveResult {
  const all = slots(roster);
  const trimmed = identifier.trim();
  if (trimmed === '') return { kind: 'not-found' };

  if (/^\d+$/.test(trimmed)) {
    const slot = all.find((s) => s.slot === Number.parseInt(trimmed, 10));
    return slot === undefined ? { kind: 'not-found' } : { kind: 'found', slot };
  }

  const lowered = trimmed.toLowerCase();
  const byAlias = all.filter((s) => s.alias !== '' && s.alias === lowered);
  if (byAlias.length === 1) return { kind: 'found', slot: byAlias[0] as RosterSlot };
  if (byAlias.length > 1) return { kind: 'ambiguous', matches: byAlias };

  const byEmail = all.filter((s) => s.email.toLowerCase() === lowered);
  if (byEmail.length === 1) return { kind: 'found', slot: byEmail[0] as RosterSlot };
  if (byEmail.length > 1) return { kind: 'ambiguous', matches: byEmail };

  return { kind: 'not-found' };
}

/** The label to show for a slot: alias if set, else email, else the number. */
export function slotLabel(slot: RosterSlot): string {
  if (slot.alias !== '') return slot.alias;
  if (slot.email !== '') return slot.email;
  return `slot ${slot.slot}`;
}

/**
 * Exchange two slots' numbers.
 *
 * The credential stash is keyed by (slot, email), so a swap has to move the
 * stash too — the caller does that. This function only rewrites the roster, and
 * returns the two entries so the caller knows exactly which files to move.
 */
export function swapSlots(
  roster: Roster,
  a: number,
  b: number,
): { a: AccountEntry; b: AccountEntry } {
  const entryA = roster.accounts[String(a)];
  const entryB = roster.accounts[String(b)];
  if (entryA === undefined) throw new Error(`slot ${a} is empty`);
  if (entryB === undefined) throw new Error(`slot ${b} is empty`);
  roster.accounts[String(a)] = entryB;
  roster.accounts[String(b)] = entryA;
  if (roster.activeSlot === a) roster.activeSlot = b;
  else if (roster.activeSlot === b) roster.activeSlot = a;
  return { a: entryA, b: entryB };
}
