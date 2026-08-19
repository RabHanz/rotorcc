/**
 * The account manager: roster + credentials + quota, in one place.
 *
 * This is what replaced shelling out to an external switcher. rotorcc owns its
 * accounts now, which means it owns the failure modes too — so the contract
 * this module keeps is narrow and absolute:
 *
 *   **An account rotorcc could not measure is reported as unmeasured.** Not as
 *   zero, not as full, not as "probably fine". `headroomPct` is `null` and
 *   `unknownReason` says which of the half-dozen reasons it was. Every caller
 *   downstream — the decision function, the status screen, the TUI, the JSON —
 *   is built on top of that null and none of them may invent a number for it.
 *
 * The shape it produces is deliberately the same `UsageReading` the rest of
 * rotorcc already consumed, so the rotation policy did not have to change when
 * the source did. Two fields were added rather than repurposed: `headroomKnown`
 * (explicit, never inferred) and `unknownReason`.
 */
import type { Config } from '../config/schema.js';
import { appPaths } from '../core/paths.js';
import type { AccountReading, UsageReading, WindowReading } from '../core/usage.js';
import { withClaudeCredentialsLock } from './ccLock.js';
import {
  CredentialStore,
  type Secret,
  accessTokenExpired,
  credentialFingerprint,
  oauthPayload,
} from './credentials.js';
import { type UsageWindow, bindingWindow, clampPct, fetchUsage, refreshToken } from './oauth.js';
import { RosterStore, type RosterSlot, slots } from './roster.js';
import { UsageCache, freshnessOf } from './usageCache.js';

export interface ManagerOptions {
  accountsDir?: string;
  env?: NodeJS.ProcessEnv;
  /** Per-model windows to count. Empty counts them all. */
  models?: string[];
  /** Injected in tests so no test ever reaches the network. */
  fetchImpl?: typeof globalThis.fetch;
  now?: () => Date;
}

export class AccountManager {
  readonly accountsDir: string;
  readonly roster: RosterStore;
  readonly credentials: CredentialStore;
  readonly cache: UsageCache;
  private readonly models: string[];
  private readonly fetchImpl: typeof globalThis.fetch | undefined;
  private readonly now: () => Date;
  private readonly env: NodeJS.ProcessEnv;

  constructor(options: ManagerOptions = {}) {
    this.env = options.env ?? process.env;
    this.accountsDir = options.accountsDir ?? appPaths(this.env).accountsDir;
    this.roster = new RosterStore(this.accountsDir);
    this.credentials = new CredentialStore({ accountsDir: this.accountsDir, env: this.env });
    this.cache = new UsageCache(this.accountsDir);
    this.models = options.models ?? [];
    this.fetchImpl = options.fetchImpl;
    this.now = options.now ?? (() => new Date());
  }

  static forConfig(config: Config, options: ManagerOptions = {}): AccountManager {
    return new AccountManager({ models: config.models, ...options });
  }

  /** True when rotorcc manages at least one account of its own. */
  hasAccounts(): boolean {
    return slots(this.roster.read()).length > 0;
  }

  /**
   * Which slot is actually live on this machine.
   *
   * Decided by comparing the live credential's fingerprint against each slot's
   * stash, NOT by trusting `roster.activeSlot`. The roster records what rotorcc
   * last did; the fingerprint records what is true. They disagree whenever
   * someone ran `claude /login` by hand, and believing the roster in that case
   * means every subsequent number is attributed to the wrong account.
   *
   * Returns null when it cannot be established — again, never a guess.
   */
  async detectActiveSlot(): Promise<{ slot: number | null; reason: string }> {
    const active = await this.credentials.readActive();
    if (active.kind === 'unreadable') {
      return { slot: null, reason: `the live credential could not be read (${active.detail})` };
    }
    if (active.kind === 'absent') {
      return { slot: null, reason: 'no Claude Code credential is present on this machine' };
    }

    const liveFingerprint = credentialFingerprint(active.value);
    if (liveFingerprint === null) {
      return { slot: null, reason: 'the live credential could not be fingerprinted' };
    }

    for (const slot of slots(this.roster.read())) {
      const stash = await this.credentials.readStash(slot.slot, slot.email);
      if (stash.kind !== 'found') continue;
      if (credentialFingerprint(stash.value) === liveFingerprint) {
        return { slot: slot.slot, reason: 'matched by credential fingerprint' };
      }
    }

    // A login rotorcc does not manage. Saying so is important: it means every
    // headroom number for "the active account" is about an account rotorcc
    // cannot name, and a rotation would discard that login's place in the
    // roster.
    return {
      slot: null,
      reason: 'the live credential does not match any account rotorcc manages',
    };
  }

  /**
   * Read quota for every managed account, refreshing tokens where needed.
   *
   * `force` bypasses the per-account poll floor (but never a server-imposed
   * backoff). The default respects it, so a TUI redrawing every second costs
   * nothing.
   */
  async readUsage(options: { force?: boolean } = {}): Promise<UsageReading> {
    const roster = this.roster.read();
    const all = slots(roster);
    const observedAt = this.now().toISOString();

    if (all.length === 0) {
      return {
        observedAt,
        activeAccountNumber: null,
        accounts: [],
        source: 'native',
        unreadableAccounts: [],
      };
    }

    const detected = await this.detectActiveSlot();
    const accounts: AccountReading[] = [];
    for (const slot of all) {
      // Every account is read inside its own guard. One account that throws —
      // a credential write that hit an unparseable config, a lock timeout, a
      // filesystem error — must cost THAT account and no other.
      //
      // This is the same discipline the individual `safeParse` per account
      // enforces one layer down, and it exists for the same reason: on
      // 2026-08-19 a single bad entry took the whole reading down, `status`
      // printed "accounts unreadable", and no rotation ever fired.
      try {
        accounts.push(
          await this.readOne(slot, {
            force: options.force ?? false,
            active: detected.slot === slot.slot,
          }),
        );
      } catch (err) {
        accounts.push({
          number: slot.slot,
          email: slot.email,
          alias: slot.alias === '' ? undefined : slot.alias,
          active: detected.slot === slot.slot,
          disabled: slot.disabled,
          kind: slot.kind,
          headroomPct: 0,
          headroomKnown: false,
          unknownReason: `reading this account threw: ${(err as Error).message.slice(0, 160)}`,
          bindingWindow: 'unknown',
          windows: [],
          stale: true,
          usageAgeMs: null,
        });
      }
    }

    return {
      observedAt,
      activeAccountNumber: detected.slot,
      accounts,
      source: 'native',
      unreadableAccounts: [],
      activeDetectionReason: detected.reason,
    };
  }

  private async readOne(
    slot: RosterSlot,
    context: { force: boolean; active: boolean },
  ): Promise<AccountReading> {
    const base = {
      number: slot.slot,
      email: slot.email,
      alias: slot.alias === '' ? undefined : slot.alias,
      active: context.active,
      disabled: slot.disabled,
      kind: slot.kind,
    };

    // An API-key slot has no quota windows at all: it bills per token and there
    // is nothing to run out of. Reporting it as 100% headroom would make it the
    // most attractive rotation target on the box, which is the opposite of what
    // an operator who has one wants.
    if (slot.kind === 'api-key') {
      return {
        ...base,
        headroomPct: 0,
        headroomKnown: false,
        unknownReason: 'API-key account: billed per token, no quota window to measure',
        bindingWindow: 'n/a',
        windows: [],
        stale: true,
        usageAgeMs: null,
      };
    }

    const cached = this.cache.entry(slot.slot);
    const shouldPoll = this.cache.mayPoll(slot.slot, { force: context.force });

    if (shouldPoll) {
      const outcome = await this.pollOne(slot);
      if (outcome.kind === 'ok') {
        this.cache.recordSuccess(slot.slot, outcome.windows, outcome.fetchedAt);
      } else if (outcome.kind === 'fetch-failed') {
        this.cache.recordFailure(slot.slot, outcome.error);
      }
      if (outcome.kind === 'credential-problem') {
        return {
          ...base,
          headroomPct: 0,
          headroomKnown: false,
          unknownReason: outcome.reason,
          bindingWindow: 'unknown',
          windows: [],
          stale: true,
          usageAgeMs: null,
        };
      }
    }

    const entry = this.cache.entry(slot.slot) ?? cached;
    const freshness = freshnessOf(entry, this.now().getTime());

    if (
      entry?.windows === null ||
      entry?.windows === undefined ||
      freshness.kind === 'never-read' ||
      freshness.kind === 'expired'
    ) {
      const why =
        freshness.kind === 'expired'
          ? `last successful read is ${formatAge(freshness.ageMs)} old — too old to act on`
          : entry?.lastError !== null && entry?.lastError !== undefined
            ? `no successful quota read yet (last attempt: ${entry.lastError})`
            : 'no quota read yet';
      return {
        ...base,
        headroomPct: 0,
        headroomKnown: false,
        unknownReason: why,
        bindingWindow: 'unknown',
        windows: [],
        stale: true,
        usageAgeMs: freshness.kind === 'never-read' ? null : freshness.ageMs,
      };
    }

    const usageWindows: UsageWindow[] = entry.windows.map((w) => ({
      name: w.name,
      usedPct: w.usedPct,
      resetsAt: w.resetsAt ?? null,
    }));
    const binding = bindingWindow(usageWindows, this.models);
    const windows: WindowReading[] = usageWindows.map((w) => ({
      name: w.name,
      headroomPct: clampPct(100 - w.usedPct),
      resetsAt: w.resetsAt ?? undefined,
    }));

    if (binding === null) {
      return {
        ...base,
        headroomPct: 0,
        headroomKnown: false,
        unknownReason: 'the quota read carried no window that gates this account',
        bindingWindow: 'unknown',
        windows,
        stale: true,
        usageAgeMs: freshness.ageMs,
      };
    }

    return {
      ...base,
      headroomPct: binding.headroomPct,
      headroomKnown: true,
      bindingWindow: binding.window.name,
      bindingResetsAt: binding.window.resetsAt ?? undefined,
      windows,
      // Fresh data is not stale; data past the stale bound is reported as such
      // and still carries its number, with its age, so a caller can decide.
      stale: freshness.kind !== 'fresh',
      usageAgeMs: freshness.ageMs,
      ...(entry.lastError !== null && entry.lastError !== undefined
        ? { lastReadError: entry.lastError }
        : {}),
    };
  }

  /**
   * Poll one account's quota, refreshing its access token first if it expired.
   *
   * The refreshed credential is written back to the stash — and, when this is
   * the live account, that write is what keeps the stash from holding a spent
   * refresh token. Getting this wrong does not show up until the next switch,
   * when the account turns out to be un-loggable-in.
   */
  private async pollOne(slot: RosterSlot): Promise<PollOutcome> {
    const stash = await this.credentials.readStash(slot.slot, slot.email);
    if (stash.kind === 'absent') {
      return {
        kind: 'credential-problem',
        reason: 'rotorcc holds no credential for this slot — re-add it',
      };
    }
    if (stash.kind === 'unreadable') {
      return { kind: 'credential-problem', reason: `credential unreadable: ${stash.detail}` };
    }

    let credential: Secret = stash.value;
    const payload = oauthPayload(credential);
    if (payload === null) {
      return {
        kind: 'credential-problem',
        reason: 'the stored credential is not an OAuth login rotorcc can use',
      };
    }

    if (accessTokenExpired(payload.expiresAt, this.now().getTime())) {
      // The ENTIRE refresh — POST, stash write, and the possible live-credential
      // write — happens under Claude Code's own credential locks.
      //
      // Without them this is exactly the race `ccLock.ts` exists to prevent: a
      // live Claude Code refreshing the same account at the same moment, both
      // processes POSTing the same one-time refresh token, and whichever write
      // lands last deciding whether the machine ends up holding a working token
      // or a dead one. A background quota poll must not be able to do that.
      const outcome = await withClaudeCredentialsLock(
        async (): Promise<PollOutcome | { kind: 'refreshed'; credential: Secret }> => {
          // Re-read inside the lock. If Claude Code refreshed while we were
          // waiting for it, the stash we read outside is already superseded and
          // POSTing its refresh token would spend a dead one.
          const fresh = await this.credentials.readStash(slot.slot, slot.email);
          const current = fresh.kind === 'found' ? fresh.value : credential;
          const currentPayload = oauthPayload(current);
          if (
            currentPayload !== null &&
            !accessTokenExpired(currentPayload.expiresAt, this.now().getTime())
          ) {
            // Somebody else refreshed it. Use theirs; spend nothing.
            return { kind: 'refreshed', credential: current };
          }

          const refreshed = await refreshToken(current, {
            degraded: fresh.kind === 'found' ? fresh.degraded : stash.degraded,
            ...(this.fetchImpl !== undefined ? { fetchImpl: this.fetchImpl } : {}),
          });
          if (!refreshed.ok) {
            if (refreshed.error === 'invalid_grant' || refreshed.error === 'no_refresh_token') {
              return {
                kind: 'credential-problem',
                reason: `this account needs a fresh login (${refreshed.error})`,
              };
            }
            return {
              kind: 'credential-problem',
              reason: `token refresh did not succeed (${refreshed.error}); quota unknown`,
            };
          }

          // Persist BEFORE using it. The old refresh token is dead the instant
          // the server answered; if the process dies between here and the next
          // write, the stash must already hold the successor or the account is
          // lost.
          await this.credentials.writeStash(slot.slot, slot.email, refreshed.credential);

          const live = await this.credentials.readActive();
          if (
            live.kind === 'found' &&
            !live.degraded &&
            credentialFingerprint(live.value) === credentialFingerprint(current)
          ) {
            // This slot is the live login and we just rotated its token. Claude
            // Code must see the successor, or its next call uses a dead one.
            //
            // A failure here is this ACCOUNT's problem and must not propagate:
            // `writeActive` can legitimately throw (a global config that exists
            // but will not parse is a deliberate refusal), and letting that out
            // aborts the quota read for every other account in the pass.
            try {
              await this.credentials.writeActive(refreshed.credential);
            } catch (err) {
              return {
                kind: 'credential-problem',
                reason:
                  'the refreshed token could not be written as the live credential ' +
                  `(${(err as Error).message.slice(0, 120)}); Claude Code may still be ` +
                  'holding a token that has been superseded',
              };
            }
          }
          return { kind: 'refreshed', credential: refreshed.credential };
        },
        { ...(this.env.CLAUDE_CONFIG_DIR !== undefined ? { env: this.env } : {}) },
      );

      if (outcome.kind !== 'refreshed') return outcome;
      credential = outcome.credential;
    }

    const accessToken = oauthPayload(credential)?.accessToken;
    if (typeof accessToken !== 'string' || accessToken === '') {
      return { kind: 'credential-problem', reason: 'the credential carries no access token' };
    }

    const result = await fetchUsage(accessToken, {
      ...(this.fetchImpl !== undefined ? { fetchImpl: this.fetchImpl } : {}),
      now: this.now,
    });
    if (!result.ok) {
      if (result.error.kind === 'unauthorised') {
        return {
          kind: 'credential-problem',
          reason: 'the quota endpoint rejected this account’s token',
        };
      }
      return { kind: 'fetch-failed', error: result.error };
    }
    return { kind: 'ok', windows: result.snapshot.windows, fetchedAt: result.snapshot.fetchedAt };
  }
}

type PollOutcome =
  | { kind: 'ok'; windows: UsageWindow[]; fetchedAt: string }
  | { kind: 'fetch-failed'; error: import('./oauth.js').UsageFetchError }
  | { kind: 'credential-problem'; reason: string };

export function formatAge(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 90) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}
