/**
 * Moving a LIVE session to another account, without replacing it.
 *
 * A Claude Code session reads its credential from disk on every request, not
 * once at launch. That was measured on 2026-08-19 against v2.1.235 rather than
 * inferred — see `docs/adr/0003-live-credential-hot-swap.md` for the method and
 * the observations. It means a rotation can be a credential change under a
 * running session instead of an abandon-and-replace, with no cold start, no
 * lost context, no new pane and no possibility of a duplicate.
 *
 * ## What this module is careful about
 *
 * **The swap itself is `switchAccount`, unchanged.** Not a quick write of
 * `.credentials.json`. That shortcut is tempting and it is wrong: the same
 * experiment found that `/status` keeps reporting the OLD account when only the
 * credential file changes, because the identity block lives in `~/.claude.json`.
 * A session running on B while every surface says A is this project's signature
 * defect wearing a new hat. `switchAccount` moves both, inside Claude Code's
 * own locks, with a rollback.
 *
 * **"Written" is not "taken".** The verification below establishes what can
 * actually be established from outside another process, and labels each piece
 * for what it is:
 *
 *   - the live credential now fingerprints as the target — a real check, and
 *     the one that catches a half-completed swap;
 *   - Claude Code's identity block names the target — the check that stops the
 *     UI lying about which account is in use;
 *   - the session did not report an authentication failure inside the deadline.
 *
 * The third is the only one that says anything about the running process, and
 * it is **negative evidence**: an idle session produces no error because it
 * makes no request, not because the swap worked. That distinction is carried in
 * the result rather than flattened, because the caller's fallback decision
 * turns on it.
 *
 * **The asymmetry that matters.** `auto` falls back to a successor on EVIDENCE
 * OF FAILURE, never on absence of evidence of success. Falling back means
 * checkpointing and replacing a session that is probably working fine, which is
 * a worse outcome than waiting for the next tick to notice a real problem.
 */
import type { Config } from '../config/schema.js';
import { AccountManager } from '../accounts/manager.js';
import { credentialFingerprint } from '../accounts/credentials.js';
import { type RosterSlot, resolveIdentifier } from '../accounts/roster.js';
import { switchAccount } from '../accounts/switch.js';
import { open, stat } from 'node:fs/promises';

import type { Logger } from './log.js';

/**
 * Signatures Claude Code prints when its credential is not accepted.
 *
 * Observed directly: swapping in a structurally valid credential with a dead
 * token produced `Login expired · Please run /login` on the very next turn.
 * The rest are the shapes the API and the SDK use for the same condition.
 */
export const AUTH_FAILURE_SIGNATURES = [
  'Login expired',
  'Please run /login',
  'OAuth token has expired',
  'authentication_error',
  'invalid_api_key',
  'Invalid bearer token',
];

export type HotSwapVerdict =
  /** The swap landed and nothing contradicted it inside the deadline. */
  | 'verified'
  /** The swap landed, but the session made no request, so nothing was observed. */
  | 'unobserved'
  /** Positive evidence the swap did not take: bad state, or an auth failure. */
  | 'failed';

export interface HotSwapResult {
  verdict: HotSwapVerdict;
  /** True when the credential and identity on disk are the target's. */
  credentialInPlace: boolean;
  /** True when the session's transcript grew during the watch. */
  sessionMadeProgress: boolean;
  /** The auth-failure line observed, when there was one. Never a credential. */
  authFailure: string | null;
  /** One line for the log, the journal and the operator. */
  detail: string;
  /** Warnings from the underlying switch transaction. */
  warnings: string[];
}

export interface HotSwapOptions {
  config: Config;
  logger: Logger;
  targetSlot: number;
  /** The live session's transcript, when there is one to watch. */
  transcriptPath?: string | undefined;
  dryRun: boolean;
  manager?: AccountManager;
  /** Injected in tests. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const POLL_MS = 2_000;

export async function hotSwapAccount(options: HotSwapOptions): Promise<HotSwapResult> {
  const { config, logger, targetSlot } = options;
  const manager =
    options.manager ??
    AccountManager.forConfig(config, {
      ...(config.accountsDir === '' ? {} : { accountsDir: config.accountsDir }),
    });

  const resolved = resolveIdentifier(manager.roster.read(), String(targetSlot));
  if (resolved.kind !== 'found') {
    return {
      verdict: 'failed',
      credentialInPlace: false,
      sessionMadeProgress: false,
      authFailure: null,
      detail: `slot ${targetSlot} is not in rotorcc's roster`,
      warnings: [],
    };
  }
  const target: RosterSlot = resolved.slot;

  if (options.dryRun) {
    return {
      verdict: 'unobserved',
      credentialInPlace: false,
      sessionMadeProgress: false,
      authFailure: null,
      detail: `DRY RUN — would hot-swap the live session onto slot ${target.slot}. Nothing written.`,
      warnings: [],
    };
  }

  const switched = await switchAccount({
    roster: manager.roster,
    credentials: manager.credentials,
    target,
  });
  for (const warning of switched.warnings) logger.warn(`hotswap: ${warning}`);
  if (!switched.ok) {
    return {
      verdict: 'failed',
      credentialInPlace: false,
      sessionMadeProgress: false,
      authFailure: null,
      detail: switched.detail,
      warnings: switched.warnings,
    };
  }

  // Check 1 and 2: the machine's own state. This is the half we control, and
  // it is where a half-completed swap shows up.
  const inPlace = await credentialIsTarget(manager, target);
  if (!inPlace.ok) {
    return {
      verdict: 'failed',
      credentialInPlace: false,
      sessionMadeProgress: false,
      authFailure: null,
      detail: `the switch reported success but ${inPlace.reason}`,
      warnings: switched.warnings,
    };
  }

  // Check 3: what the live session does next.
  const watch = await watchForAuthFailure(options);
  if (watch.authFailure !== null) {
    return {
      verdict: 'failed',
      credentialInPlace: true,
      sessionMadeProgress: watch.madeProgress,
      authFailure: watch.authFailure,
      detail:
        `the credential was swapped, but the live session then reported an authentication ` +
        `failure (${watch.authFailure}). It is NOT running on slot ${target.slot}.`,
      warnings: switched.warnings,
    };
  }

  return {
    verdict: watch.madeProgress ? 'verified' : 'unobserved',
    credentialInPlace: true,
    sessionMadeProgress: watch.madeProgress,
    authFailure: null,
    detail: watch.madeProgress
      ? `hot-swapped onto slot ${target.slot} (${target.email}); the live session kept working ` +
        'across the change'
      : `hot-swapped onto slot ${target.slot} (${target.email}). The session made no request ` +
        'during the watch, so nothing confirms it picked the new credential up — the credential ' +
        'and identity on disk are correct, which is all that can be checked from outside.',
    warnings: switched.warnings,
  };
}

/** Does the machine's live credential, and its identity block, name the target? */
async function credentialIsTarget(
  manager: AccountManager,
  target: RosterSlot,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const live = await manager.credentials.readActive();
  if (live.kind !== 'found') {
    return {
      ok: false,
      reason:
        live.kind === 'absent'
          ? 'there is now no credential on this machine at all'
          : `the live credential could not be read back (${live.detail})`,
    };
  }
  const stash = await manager.credentials.readStash(target.slot, target.email);
  if (stash.kind !== 'found') {
    return { ok: false, reason: `slot ${target.slot}'s stored credential could not be read back` };
  }
  if (credentialFingerprint(live.value) !== credentialFingerprint(stash.value)) {
    return {
      ok: false,
      reason: 'the live credential does not fingerprint as the target account',
    };
  }

  // The identity block is what every surface reads to say which account is in
  // use. A swap that leaves it behind produces a session running on one account
  // while the screen names another.
  const identity = manager.credentials.readGlobalConfig()?.oauthAccount;
  const expected = manager.credentials.readAccountIdentity(target.slot, target.email);
  if (expected !== null && JSON.stringify(identity) !== JSON.stringify(expected)) {
    return {
      ok: false,
      reason:
        "Claude Code's identity block still names a different account, so every surface would " +
        'report the wrong one',
    };
  }
  return { ok: true };
}

/**
 * Watch the live session's transcript for an authentication failure.
 *
 * Returns whether the transcript GREW as well as whether it failed, because
 * those answer different questions. Growth means the session made a request
 * after the swap, which is the only thing that turns "no error" into evidence.
 */
async function watchForAuthFailure(
  options: HotSwapOptions,
): Promise<{ authFailure: string | null; madeProgress: boolean }> {
  const seconds = options.config.rotation.hotswapVerifySeconds;
  const path = options.transcriptPath;
  if (seconds <= 0 || path === undefined || path === '') {
    return { authFailure: null, madeProgress: false };
  }

  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const clock = options.now ?? (() => Date.now());
  const deadline = clock() + seconds * 1000;

  // The byte offset at the moment of the swap, NOT a snapshot of the tail.
  //
  // Comparing tails and slicing off a matching prefix looks equivalent and is
  // not: a transcript is normally far larger than any tail window, so once the
  // session appends anything the window slides and the new tail does not start
  // with the old one. The whole window then reads as "fresh", every
  // authentication failure the session ever printed is re-found, and a working
  // swap is reported as broken — which in `auto` mode replaces a live, healthy
  // session. An offset cannot slide.
  const start = await fileSize(path);
  let madeProgress = false;

  for (;;) {
    await sleep(POLL_MS);
    const size = await fileSize(path);
    if (size > start) madeProgress = true;
    // A transcript that SHRANK was rotated or truncated under us. There is no
    // longer any way to tell which bytes are new, so scan nothing rather than
    // scan everything and report a failure that may predate the swap.
    const fresh = size >= start ? await readFrom(path, start) : '';
    const hit = AUTH_FAILURE_SIGNATURES.find((signature) => fresh.includes(signature));
    if (hit !== undefined) return { authFailure: hit, madeProgress: true };
    if (clock() >= deadline) return { authFailure: null, madeProgress };
  }
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

/**
 * Everything written to `path` from `offset` onward, capped.
 *
 * The cap is a guard, not a window: a session that produced megabytes during
 * the watch is not a session whose bytes all need scanning, and reading an
 * unbounded amount inside a watcher tick is its own defect.
 */
async function readFrom(path: string, offset: number, limit = 4 * 1024 * 1024): Promise<string> {
  let handle;
  try {
    handle = await open(path, 'r');
  } catch {
    return '';
  }
  try {
    const size = (await handle.stat()).size;
    const length = Math.min(Math.max(0, size - offset), limit);
    if (length === 0) return '';
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, offset);
    return buffer.toString('utf8');
  } catch {
    return '';
  } finally {
    await handle.close();
  }
}
