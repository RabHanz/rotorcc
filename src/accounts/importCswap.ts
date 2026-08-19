/**
 * One-time import of accounts from claude-swap's store.
 *
 * This exists so that adopting rotorcc costs nobody a re-login. It reads the
 * other tool's store ONCE, copies what it finds into rotorcc's own, and then
 * rotorcc never looks at it again — there is no ongoing dependency, no version
 * coupling, and nothing that breaks when the other tool upgrades.
 *
 * Read-only with respect to the source. Nothing here writes to, moves, or
 * deletes anything in claude-swap's directory: an operator who imports and then
 * decides they preferred the old tool must find it exactly as they left it.
 *
 * Every slot is imported INDEPENDENTLY. One account whose credential file is
 * corrupt costs that account and no other — the same discipline that had to be
 * retrofitted to the usage reader after one `"usage": null` blinded all three.
 *
 * claude-swap is MIT-licensed, by Onur Cetinkol; see THIRD-PARTY-NOTICES.md.
 * The store layout below was read from an installed copy, not guessed.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { z } from 'zod';

import { type CredentialStore, asSecret, classifyCredential } from './credentials.js';
import { type Roster, type RosterStore, normaliseAlias } from './roster.js';

/**
 * Where claude-swap keeps its store.
 *
 * Linux and WSL follow XDG; macOS and Windows kept the older
 * `~/.claude-swap-backup`. Both are checked regardless of platform, because an
 * operator who moved a home directory between machines can easily have the
 * other one.
 */
export function cswapStoreCandidates(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string[] {
  const candidates: string[] = [];
  const xdg = env.XDG_DATA_HOME;
  if (xdg !== undefined && xdg !== '' && (xdg.startsWith('/') || /^[a-zA-Z]:/.test(xdg))) {
    candidates.push(join(xdg, 'claude-swap'));
  }
  candidates.push(join(home, '.local', 'share', 'claude-swap'));
  candidates.push(join(home, '.claude-swap-backup'));
  return candidates;
}

export function findCswapStore(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string | null {
  for (const candidate of cswapStoreCandidates(env, home)) {
    if (existsSync(join(candidate, 'sequence.json'))) return candidate;
  }
  return null;
}

const sequenceSchema = z
  .object({
    activeAccountNumber: z.number().int().nullish(),
    accounts: z.record(z.string(), z.unknown()).default({}),
  })
  .passthrough();

const accountSchema = z
  .object({
    email: z.string().min(1),
    uuid: z.string().nullish(),
    organizationUuid: z.string().nullish(),
    organizationName: z.string().nullish(),
    added: z.string().nullish(),
    alias: z.string().nullish(),
  })
  .passthrough();

export interface ImportedSlot {
  slot: number;
  email: string;
  /** Whether a usable credential came across. Without one the slot is a stub. */
  credential: boolean;
  /** Whether the account identity block came across. */
  identity: boolean;
  alias: string;
  note: string;
}

export interface ImportReport {
  storePath: string | null;
  imported: ImportedSlot[];
  /** Slots that were present in the source but could not be brought over. */
  skipped: Array<{ slot: number | null; reason: string }>;
  /** Slots already in rotorcc's roster that were left alone. */
  alreadyPresent: number[];
  dryRun: boolean;
}

export interface ImportOptions {
  roster: RosterStore;
  credentials: CredentialStore;
  /** Explicit source directory; auto-detected when omitted. */
  from?: string;
  dryRun?: boolean;
  /** Overwrite a slot rotorcc already holds. Off by default. */
  overwrite?: boolean;
  env?: NodeJS.ProcessEnv;
  home?: string;
}

export async function importFromCswap(options: ImportOptions): Promise<ImportReport> {
  const storePath =
    options.from ?? findCswapStore(options.env ?? process.env, options.home ?? homedir());
  const report: ImportReport = {
    storePath,
    imported: [],
    skipped: [],
    alreadyPresent: [],
    dryRun: options.dryRun ?? false,
  };

  if (storePath === null) {
    report.skipped.push({
      slot: null,
      reason:
        'no claude-swap store was found. Looked in ' +
        cswapStoreCandidates(options.env ?? process.env, options.home ?? homedir()).join(', '),
    });
    return report;
  }

  const sequencePath = join(storePath, 'sequence.json');
  let sequence: z.infer<typeof sequenceSchema>;
  try {
    const parsed = sequenceSchema.safeParse(JSON.parse(readFileSync(sequencePath, 'utf8')));
    if (!parsed.success) {
      report.skipped.push({ slot: null, reason: `${sequencePath} is not a shape rotorcc reads` });
      return report;
    }
    sequence = parsed.data;
  } catch (err) {
    report.skipped.push({
      slot: null,
      reason: `${sequencePath} could not be read: ${(err as Error).message.slice(0, 120)}`,
    });
    return report;
  }

  const existing: Roster = options.roster.read();
  const takenAliases = new Set(
    Object.values(existing.accounts)
      .map((a) => a.alias)
      .filter((a) => a !== ''),
  );

  for (const [key, raw] of Object.entries(sequence.accounts)) {
    const slot = Number.parseInt(key, 10);
    if (!Number.isInteger(slot)) {
      report.skipped.push({ slot: null, reason: `"${key}" is not a slot number` });
      continue;
    }

    // Parsed one at a time. One malformed entry costs that account, not the run.
    const parsed = accountSchema.safeParse(raw);
    if (!parsed.success) {
      report.skipped.push({ slot, reason: 'the account entry was not a shape rotorcc reads' });
      continue;
    }
    const account = parsed.data;

    if (existing.accounts[String(slot)] !== undefined && options.overwrite !== true) {
      report.alreadyPresent.push(slot);
      continue;
    }

    const credential = readCswapCredential(storePath, slot, account.email);
    const identity = readCswapIdentity(storePath, slot, account.email);

    if (credential === null) {
      // A slot with no credential is worse than useless: it would sit in the
      // roster looking like a rotation target and fail every time it was
      // chosen. Skipped, with the reason, so the operator can re-add it.
      report.skipped.push({
        slot,
        reason: `no readable credential for ${account.email} in the source store; re-add this one by hand`,
      });
      continue;
    }

    let alias = '';
    if (typeof account.alias === 'string' && account.alias !== '') {
      try {
        const candidate = normaliseAlias(account.alias);
        // An alias that already means something else in rotorcc's roster is
        // dropped rather than duplicated: two slots answering to one name makes
        // every later `switch <alias>` ambiguous.
        if (!takenAliases.has(candidate)) {
          alias = candidate;
          takenAliases.add(candidate);
        }
      } catch {
        /* an alias the source allowed and rotorcc does not; drop it silently */
      }
    }

    const kind = classifyCredential(credential) === 'api-key' ? 'api-key' : 'oauth';

    if (options.dryRun !== true) {
      await options.credentials.writeStash(slot, account.email, asSecret(credential));
      if (identity !== null) {
        options.credentials.writeAccountIdentity(slot, account.email, identity);
      }
      options.roster.update((roster) => {
        roster.accounts[String(slot)] = {
          email: account.email,
          uuid: account.uuid ?? '',
          organizationUuid: account.organizationUuid ?? '',
          organizationName: account.organizationName ?? '',
          added: account.added ?? new Date().toISOString(),
          alias,
          disabled: false,
          kind,
        };
      });
    }

    report.imported.push({
      slot,
      email: account.email,
      credential: true,
      identity: identity !== null,
      alias,
      note:
        identity === null
          ? 'credential imported; no stored identity, so this account will be identified on first capture'
          : 'credential and identity imported',
    });
  }

  // The active slot is NOT copied across. rotorcc establishes which account is
  // live by fingerprinting the actual credential on the machine, and inheriting
  // another tool's opinion would be exactly the kind of unverified assertion
  // this project keeps getting bitten by.
  return report;
}

/** claude-swap stores each credential base64-encoded in a `.enc` file. */
function readCswapCredential(storePath: string, slot: number, email: string): string | null {
  const direct = join(storePath, 'credentials', `.creds-${slot}-${email}.enc`);
  const candidates = [direct];

  // Fall back to a scan: an email with a character that got normalised on the
  // way into the filename would otherwise be invisible, and the operator would
  // be told to re-add an account that is right there.
  try {
    const dir = join(storePath, 'credentials');
    if (existsSync(dir)) {
      for (const name of readdirSync(dir)) {
        if (name.startsWith(`.creds-${slot}-`) && name.endsWith('.enc')) {
          candidates.push(join(dir, name));
        }
      }
    }
  } catch {
    /* the direct path is still worth trying */
  }

  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const decoded = Buffer.from(readFileSync(path, 'utf8'), 'base64').toString('utf8');
      if (decoded.trim() === '') continue;
      // Only accept something that is actually a credential. A truncated or
      // half-written file decodes to noise, and importing noise creates a slot
      // that fails at the worst possible moment instead of at import time.
      if (classifyCredential(decoded) === 'unknown') continue;
      return decoded;
    } catch {
      continue;
    }
  }
  return null;
}

/** The `oauthAccount` block out of claude-swap's per-account config backup. */
function readCswapIdentity(storePath: string, slot: number, email: string): unknown | null {
  const dir = join(storePath, 'configs');
  const candidates = [join(dir, `.claude-config-${slot}-${email}.json`)];
  try {
    if (existsSync(dir)) {
      for (const name of readdirSync(dir)) {
        if (name.startsWith(`.claude-config-${slot}-`) && name.endsWith('.json')) {
          candidates.push(join(dir, name));
        }
      }
    }
  } catch {
    /* fall through */
  }

  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
      if (typeof parsed !== 'object' || parsed === null) continue;
      const identity = (parsed as Record<string, unknown>).oauthAccount;
      if (identity !== undefined && identity !== null) return identity;
    } catch {
      continue;
    }
  }
  return null;
}
