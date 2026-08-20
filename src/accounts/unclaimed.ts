/**
 * Orphaned credentials: files in rotorcc's credential store that no roster
 * entry claims.
 *
 * The switch transaction stashes the account it is leaving before it activates
 * the one it is going to, and `swap` deliberately writes both new copies before
 * it touches the roster — so a crash in the wrong millisecond leaves a real
 * credential at a (slot, email) nothing points at any more. Today nothing
 * surfaces that. The bytes sit there at 0600 forever: not dangerous, but a
 * login the operator believes they deleted, and a login they might have
 * believed they still had.
 *
 * The rules this module is built to:
 *
 *   - **Never guess that something is rubbish.** An entry is reported with
 *     enough identity to decide about — which slot it claims, whose login it
 *     is, how old it is, and the specific reason nothing claims it.
 *   - **Never delete in bulk.** There is no "purge all". A caller purges one
 *     explicit id, and an id that matches nothing is an error rather than a
 *     no-op, because "it deleted something, just not that" is worse.
 *   - **Never print a credential.** Identity is a fingerprint, a kind, and
 *     whatever the sidecar identity file already recorded in plaintext.
 */
import { existsSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import {
  classifyCredential,
  credentialFingerprint,
  oauthPayload,
  safeFileFragment,
} from './credentials.js';
import { type Roster, slots } from './roster.js';

/** Why the store holds something the roster does not. */
export type OrphanReason =
  /** No roster entry has this slot number at all. */
  | 'slot-not-in-roster'
  /** The slot exists, but it holds a different login now. */
  | 'slot-holds-another-account'
  /** A `.prev` recovery copy whose current generation is gone. */
  | 'retained-previous-generation'
  /** An identity sidecar with no credential beside it and no roster entry. */
  | 'identity-without-credential';

export interface UnclaimedEntry {
  /** The handle `--purge` takes. The file's base name: explicit, stable, typo-proof. */
  id: string;
  /** The slot number the filename claims. Null when the name does not carry one. */
  slot: number | null;
  /**
   * The login, as best it can be known.
   *
   * The filename is a SANITISED email, so it may differ from the real one where
   * the address contained a character that is not filename-safe. The identity
   * sidecar, when there is one, carries the real address and wins.
   */
  email: string | null;
  emailIsExact: boolean;
  reason: OrphanReason;
  /** Human sentence for the reason, naming what does claim that slot. */
  detail: string;
  /** Every file that `--purge <id>` would remove. */
  files: string[];
  bytes: number;
  /** ISO time of the newest of those files. */
  modifiedAt: string | null;
  ageMs: number | null;
  /** Safe: a truncated hash of the refresh token, never the token. */
  fingerprint: string | null;
  kind: 'oauth' | 'api-key' | 'unknown' | 'not-a-credential';
  /** ISO expiry of the access token inside, when it is an OAuth credential. */
  accessTokenExpiresAt: string | null;
}

const CRED_SUFFIX = '.cred';
const PREV_SUFFIX = '.cred.prev';
const CONFIG_SUFFIX = '.config.json';

/** `2-someone@example.com.cred` → slot 2, email `someone@example.com`. */
export function parseStashName(name: string): { slot: number; emailFragment: string } | null {
  const match = /^(\d+)-(.*)$/.exec(name);
  if (match === null) return null;
  const slot = Number.parseInt(match[1] as string, 10);
  if (!Number.isInteger(slot)) return null;
  return { slot, emailFragment: match[2] as string };
}

function decodeBase64(text: string): string | null {
  try {
    const decoded = Buffer.from(text, 'base64').toString('utf8');
    return decoded === '' ? null : decoded;
  } catch {
    return null;
  }
}

/**
 * Everything in the credential directory that the roster does not claim.
 *
 * Filesystem only. On macOS a stash can also live in the Keychain, and this
 * does NOT enumerate those — `security` has no listing that works without a
 * prompt, and a scan that quietly covers one backend while implying it covered
 * both is the kind of half-truth this project keeps paying for. The caller
 * reports that limitation rather than hiding it.
 */
export function findUnclaimed(
  accountsDir: string,
  roster: Roster,
  nowMs: number = Date.now(),
): UnclaimedEntry[] {
  const dir = join(accountsDir, 'credentials');
  if (!existsSync(dir)) return [];

  const claimed = new Map<number, string>();
  for (const slot of slots(roster)) claimed.set(slot.slot, safeFileFragment(slot.email));

  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }

  const entries: UnclaimedEntry[] = [];
  const seen = new Set<string>();

  for (const name of names.sort()) {
    // `.prev` is tested first when the base name is computed: `x.cred.prev`
    // does not end with `.cred`, but stripping the wrong suffix would produce a
    // base of `x.cred`, and every file lookup from there would miss.
    const isCred = name.endsWith(CRED_SUFFIX);
    const isPrev = name.endsWith(PREV_SUFFIX);
    const isConfig = name.endsWith(CONFIG_SUFFIX);
    if (!isCred && !isPrev && !isConfig) continue;

    const base = isPrev
      ? name.slice(0, -PREV_SUFFIX.length)
      : isCred
        ? name.slice(0, -CRED_SUFFIX.length)
        : name.slice(0, -CONFIG_SUFFIX.length);
    if (seen.has(base)) continue;

    const parsed = parseStashName(base);
    const slot = parsed?.slot ?? null;
    const fragment = parsed?.emailFragment ?? null;
    const claimedFragment = slot === null ? undefined : claimed.get(slot);

    if (claimedFragment !== undefined && claimedFragment === fragment) continue; // in use

    seen.add(base);

    const credPath = join(dir, `${base}${CRED_SUFFIX}`);
    const prevPath = join(dir, `${base}${PREV_SUFFIX}`);
    const configPath = join(dir, `${base}${CONFIG_SUFFIX}`);
    const files = [credPath, prevPath, configPath].filter((path) => existsSync(path));
    if (files.length === 0) continue;

    let bytes = 0;
    let newest: number | null = null;
    for (const path of files) {
      try {
        const stat = statSync(path);
        bytes += stat.size;
        if (newest === null || stat.mtimeMs > newest) newest = stat.mtimeMs;
      } catch {
        /* a file that vanished between readdir and stat is simply not counted */
      }
    }

    const hasCred = existsSync(credPath);
    const hasPrev = existsSync(prevPath);

    // Why nothing claims it, said in terms of the roster, because that is what
    // the operator can check. The "only a .prev survives" case is its own
    // reason: those bytes are a generation OLD, and an operator deciding
    // whether to keep them needs to know that before they decide.
    const rosterDetail =
      slot === null
        ? 'the filename carries no slot number rotorcc recognises'
        : claimedFragment === undefined
          ? `no account occupies slot ${slot}`
          : `slot ${slot} now holds ${claimedFragment}`;

    let reason: OrphanReason;
    let detail: string;
    if (!hasCred && !hasPrev) {
      reason = 'identity-without-credential';
      detail = `an account identity file with no credential beside it — ${rosterDetail}`;
    } else if (!hasCred) {
      reason = 'retained-previous-generation';
      detail = `only the retained previous generation survives — ${rosterDetail}`;
    } else if (slot === null || claimedFragment === undefined) {
      reason = 'slot-not-in-roster';
      detail = rosterDetail;
    } else {
      reason = 'slot-holds-another-account';
      detail = rosterDetail;
    }

    // Only ever read to classify. The decoded value stays in this scope and is
    // reduced to a fingerprint and a kind before anything leaves the function.
    let fingerprint: string | null = null;
    let kind: UnclaimedEntry['kind'] = 'not-a-credential';
    let expires: string | null = null;
    const source = hasCred ? credPath : hasPrev ? prevPath : null;
    if (source !== null) {
      let decoded: string | null = null;
      try {
        decoded = decodeBase64(readFileSync(source, 'utf8'));
      } catch {
        decoded = null;
      }
      if (decoded !== null) {
        fingerprint = credentialFingerprint(decoded);
        kind = classifyCredential(decoded);
        const payload = oauthPayload(decoded);
        if (typeof payload?.expiresAt === 'number' && Number.isFinite(payload.expiresAt)) {
          expires = new Date(payload.expiresAt).toISOString();
        }
      }
    }

    const identityEmail = readIdentityEmail(configPath);

    entries.push({
      id: base,
      slot,
      email: identityEmail ?? (fragment === null || fragment === '' ? null : fragment),
      emailIsExact: identityEmail !== null,
      reason,
      detail,
      files,
      bytes,
      modifiedAt: newest === null ? null : new Date(newest).toISOString(),
      ageMs: newest === null ? null : Math.max(0, nowMs - newest),
      fingerprint,
      kind,
      accessTokenExpiresAt: expires,
    });
  }

  return entries;
}

function readIdentityEmail(configPath: string): string | null {
  if (!existsSync(configPath)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(configPath, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return null;
    const identity = (parsed as Record<string, unknown>).oauthAccount;
    if (typeof identity !== 'object' || identity === null) return null;
    const record = identity as Record<string, unknown>;
    const email = record.emailAddress ?? record.email;
    return typeof email === 'string' && email !== '' ? email : null;
  } catch {
    return null;
  }
}

export type PurgeOutcome =
  | { ok: true; removed: string[] }
  | { ok: false; error: 'no-such-id' | 'claimed' | 'failed'; detail: string };

/**
 * Delete exactly one orphan, by exact id.
 *
 * Re-derives the orphan list rather than trusting an id handed in from
 * somewhere: between the listing and the purge the roster can have changed, and
 * deleting a credential that has since been claimed is unrecoverable.
 */
export function purgeUnclaimed(accountsDir: string, roster: Roster, id: string): PurgeOutcome {
  const entries = findUnclaimed(accountsDir, roster);
  const entry = entries.find((candidate) => candidate.id === id);
  if (entry === undefined) {
    const claimedNow = slots(roster).some(
      (slot) => `${slot.slot}-${safeFileFragment(slot.email)}` === id,
    );
    return claimedNow
      ? {
          ok: false,
          error: 'claimed',
          detail: `"${id}" is a live account's credential, not an orphan. Use "rotorcc accounts remove".`,
        }
      : { ok: false, error: 'no-such-id', detail: `nothing unclaimed matches "${id}"` };
  }

  const removed: string[] = [];
  for (const file of entry.files) {
    try {
      unlinkSync(file);
      removed.push(file);
    } catch (err) {
      return {
        ok: false,
        error: 'failed',
        detail: `removed ${removed.length} of ${entry.files.length} file(s); ${file} would not delete: ${(err as Error).message.slice(0, 120)}`,
      };
    }
  }
  return { ok: true, removed };
}
