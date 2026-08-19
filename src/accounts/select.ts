/**
 * Choosing what to rotate onto.
 *
 * Four strategies. Three are the ones any account switcher needs; the fourth is
 * the reason rotorcc exists.
 *
 *   best            most headroom wins. The obvious one, and the right default
 *                   when nothing is running.
 *   next-available  the next slot in order that is not exhausted. Predictable,
 *                   which some operators want more than optimal — it spreads
 *                   usage evenly and makes "which account am I on" guessable.
 *   consume-first   prefer the account whose weekly window resets soonest, so
 *                   quota that is about to be thrown away gets used. Costs
 *                   nothing when it is right and one extra rotation when it is
 *                   wrong.
 *   work-aware      rotorcc's own. Filter to accounts with enough headroom to
 *                   FINISH what is running, then apply `best` among those. When
 *                   nothing qualifies, it says so instead of picking the least
 *                   bad and calling it a plan.
 *
 * Every strategy returns a REASON, and the reason is as much the product as the
 * choice is. A rotation that happened silently is a rotation nobody can audit
 * afterwards, and "why did it pick that one" is the first question asked when
 * something goes wrong.
 *
 * Two things every strategy refuses, without exception:
 *   - an account whose headroom is UNKNOWN. Not measured is not "probably fine".
 *   - an account the operator disabled, unless they named it explicitly.
 *
 * ## Why ranking is not `sort by headroomPct`
 *
 * It used to be, and that was wrong in a way that is easy to miss.
 *
 * `headroomPct` is the headroom on an account's BINDING window, and the binding
 * window differs per account. So the naive sort compares "10% of a week" with
 * "1% of five hours" as though they were the same quantity. They are not, and
 * the two differ in the thing that actually matters — **when it comes back**:
 *
 * | account | 5h    | 7d    | binding    | naive rank |
 * | ------- | ----- | ----- | ---------- | ---------- |
 * | A       | 100%  | 10%   | 7d at 10%  | **first**  |
 * | B       | 1%    | 28%   | 5h at 1%   | second     |
 *
 * A's constraint is its WEEK and does not recover for days. B's constraint is a
 * five-hour window that refills within the hour, after which B still holds 28%
 * of its week. For any session longer than that reset, B is the better target
 * and the naive sort picks the worse one — and picks it precisely when an
 * operator is out of options and least able to notice.
 *
 * So ranking is on two facts, in this order:
 *
 *   1. **the weekly budget**, because that is the resource an operator regrets
 *      spending (the same judgement as ADR 0002, in the same units);
 *   2. **readiness**, meaning the 5-hour window either has room now or resets
 *      inside the horizon we are choosing for.
 *
 * An account that is not ready is not excluded — it is ranked below every ready
 * one, because it is still better than nothing when nothing else qualifies.
 *
 * Where a fact is unknown it is never resolved optimistically: an unknown reset
 * time does not become "it will be back soon", and an account with no weekly
 * reading falls back to its binding headroom with the reason said out loud.
 */
import type { AccountReading, UsageReading } from '../core/usage.js';
import { headroomIsKnown } from '../core/usage.js';
import { weeklyHeadroom, windowsOf } from '../core/policy.js';

export type Strategy = 'best' | 'next-available' | 'consume-first' | 'work-aware';

export const STRATEGIES: Strategy[] = ['best', 'next-available', 'consume-first', 'work-aware'];

export interface SelectOptions {
  strategy: Strategy;
  /** The account being rotated away from, excluded from consideration. */
  activeNumber: number | null;
  /** A candidate must have at least this much headroom. */
  minHeadroomPct: number;
  /**
   * Headroom the work in flight is estimated to need, or null when unknown.
   * Only `work-aware` uses it, and when it is null that strategy says it cannot
   * size the target rather than falling back to `best` and pretending.
   */
  neededHeadroomPct?: number | null;
  /** Allow API-key accounts as a target. They bill per token, so: off. */
  includeApiKeyAccounts?: boolean;
  /** Consider accounts the operator disabled. Only for an explicit request. */
  includeDisabled?: boolean;
  /**
   * How far ahead the choice is being made for. A 5-hour window that resets
   * inside this counts as available; one that resets after it does not.
   *
   * Four hours by default — long enough that a spent 5-hour window usually
   * clears inside it, short enough that it is a claim about this session rather
   * than about tomorrow. It is an option because the honest value depends on
   * what is running, and a caller that knows should say so.
   */
  horizonMs?: number;
  /** Per-model weekly windows to count, matching `config.models`. */
  models?: string[];
  /** Injected for tests. */
  now?: () => Date;
}

/** The default planning horizon: see `SelectOptions.horizonMs`. */
export const DEFAULT_HORIZON_MS = 4 * 60 * 60 * 1000;

/**
 * What an account is actually worth as a target, with the reasoning attached.
 *
 * Everything here is derived from readings the account already carried. Nothing
 * is estimated, and every field that could not be established is `null` rather
 * than a stand-in.
 */
export interface Capacity {
  /** Headroom on the binding window right now — the old, naive ranking key. */
  nowPct: number;
  /** Headroom on the weekly budget, folding per-model caps. Null when unknown. */
  weeklyPct: number | null;
  /** Headroom on the 5-hour window. Null when the account did not report one. */
  fiveHourPct: number | null;
  /** Milliseconds until the binding window resets. Null when not reported. */
  bindingResetsInMs: number | null;
  /**
   * True when the account can be worked on inside the horizon: either its
   * 5-hour window has room now, or it resets before the horizon ends.
   *
   * An unknown reset time makes this FALSE, never true. "We do not know when it
   * comes back" is not evidence that it comes back soon.
   */
  ready: boolean;
  /** The number the ranking is on: weekly headroom, or the binding one. */
  rankPct: number;
  /** Human sentence, carrying the window each number belongs to. */
  note: string;
}

export function capacityOf(
  account: AccountReading,
  options: { horizonMs?: number; models?: string[]; nowMs?: number } = {},
): Capacity {
  const horizonMs = options.horizonMs ?? DEFAULT_HORIZON_MS;
  const nowMs = options.nowMs ?? Date.now();
  const view = windowsOf(account, options.models ?? []);
  const weekly = weeklyHeadroom(account, options.models ?? []);

  const resetsAt = account.bindingResetsAt;
  const parsed = resetsAt === undefined ? Number.NaN : Date.parse(resetsAt);
  const bindingResetsInMs = Number.isNaN(parsed) ? null : Math.max(0, parsed - nowMs);

  // Readiness is about the RATE limit, not the budget. A 5-hour window with
  // room is ready now; one that is spent is ready once it resets, and only if
  // we know when that is.
  const fiveHour = view.fiveHourPct;
  const fiveHourHasRoom = fiveHour === null ? false : fiveHour > 0;
  const fiveHourIsBinding = account.bindingWindow === '5h';
  const resetsInsideHorizon =
    fiveHourIsBinding && bindingResetsInMs !== null && bindingResetsInMs <= horizonMs;
  // No 5-hour reading at all: nothing says this account is rate-limited, so it
  // is not held back on that account. The binding window still gates the rank.
  const ready = fiveHour === null ? true : fiveHourHasRoom || resetsInsideHorizon;

  const rankPct = weekly.pct ?? account.headroomPct;

  const parts: string[] = [];
  parts.push(`${account.headroomPct.toFixed(0)}% on ${account.bindingWindow} now`);
  if (weekly.pct !== null && account.bindingWindow !== weekly.window) {
    parts.push(`${weekly.pct.toFixed(0)}% of its ${weekly.window} budget`);
  }
  if (fiveHourIsBinding && !fiveHourHasRoom) {
    parts.push(
      bindingResetsInMs === null
        ? 'its 5h window is spent and its reset time is unknown'
        : `its 5h window resets in ${formatDuration(bindingResetsInMs)}${resetsInsideHorizon ? '' : ', after the horizon'}`,
    );
  }
  if (weekly.pct === null) parts.push('no weekly reading, so ranked on the binding window alone');

  return {
    nowPct: account.headroomPct,
    weeklyPct: weekly.pct,
    fiveHourPct: fiveHour,
    bindingResetsInMs,
    ready,
    rankPct,
    note: parts.join('; '),
  };
}

function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 90) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

export interface Candidate {
  account: AccountReading;
  /** Why this one was ranked where it was. */
  note: string;
}

export interface Selection {
  /** The chosen account, or null when nothing qualified. */
  chosen: AccountReading | null;
  /** Everything that was considered and survived the filters, best first. */
  ranked: Candidate[];
  /** Everything that was excluded, with the reason. Never silently dropped. */
  rejected: Array<{ account: AccountReading; reason: string }>;
  /** One line for the log, the manifest and the TUI. Always populated. */
  reason: string;
  strategy: Strategy;
}

export function selectTarget(reading: UsageReading, options: SelectOptions): Selection {
  const rejected: Selection['rejected'] = [];
  const eligible: AccountReading[] = [];

  for (const account of reading.accounts) {
    if (options.activeNumber !== null && account.number === options.activeNumber) {
      rejected.push({ account, reason: 'this is the account we are leaving' });
      continue;
    }
    if (account.kind === 'api-key' && options.includeApiKeyAccounts !== true) {
      rejected.push({
        account,
        reason: 'API-key account: bills per token, excluded unless explicitly allowed',
      });
      continue;
    }
    if (account.disabled === true && options.includeDisabled !== true) {
      rejected.push({ account, reason: 'disabled by the operator' });
      continue;
    }
    if (!headroomIsKnown(account)) {
      // The most important rejection in this file. An account rotorcc could not
      // measure is not a target; rotating onto an unknown is how a session
      // moves from an account with 5% left to one with none.
      rejected.push({
        account,
        reason: `headroom unknown — ${account.unknownReason ?? 'not measured'}`,
      });
      continue;
    }
    if (account.headroomPct < options.minHeadroomPct) {
      rejected.push({
        account,
        reason: `${account.headroomPct.toFixed(0)}% headroom is under the ${options.minHeadroomPct}% floor`,
      });
      continue;
    }
    eligible.push(account);
  }

  if (eligible.length === 0) {
    return {
      chosen: null,
      ranked: [],
      rejected,
      reason:
        rejected.length === 0
          ? 'there are no other accounts to rotate onto'
          : `no account qualified: ${rejected.map((r) => `#${r.account.number} ${r.reason}`).join('; ')}`,
      strategy: options.strategy,
    };
  }

  switch (options.strategy) {
    case 'best':
      return finish(
        rankByCapacity(eligible, options),
        rejected,
        options.strategy,
        'largest weekly budget that is usable within the horizon',
      );

    case 'next-available': {
      // The next slot number above the active one, wrapping. Predictable is the
      // whole point, so the ordering is by slot and not by anything clever.
      const from = options.activeNumber ?? 0;
      const ranked = [...eligible]
        .sort((a, b) => a.number - b.number)
        .sort((a, b) => wrapDistance(from, a.number) - wrapDistance(from, b.number))
        .map((account) => ({
          account,
          note: `slot ${account.number}, ${account.headroomPct.toFixed(0)}% headroom`,
        }));
      return finish(ranked, rejected, options.strategy, 'next slot in order, skipping exhausted');
    }

    case 'consume-first': {
      // Prefer quota that is about to expire. An account whose weekly window
      // resets in six hours has quota that will be thrown away; one resetting
      // in six days does not. Accounts with no known reset sort last, because
      // an unknown reset time is not evidence of an imminent one.
      const ranked = [...eligible]
        .sort((a, b) => b.headroomPct - a.headroomPct)
        .sort((a, b) => resetRank(a) - resetRank(b))
        .map((account) => ({
          account,
          note:
            account.bindingResetsAt === undefined
              ? `${account.headroomPct.toFixed(0)}% headroom, reset time unknown`
              : `${account.headroomPct.toFixed(0)}% headroom, resets ${account.bindingResetsAt.slice(0, 16).replace('T', ' ')}`,
        }));
      return finish(
        ranked,
        rejected,
        options.strategy,
        'soonest reset first, to spend expiring quota',
      );
    }

    case 'work-aware': {
      const needed = options.neededHeadroomPct ?? null;
      if (needed === null) {
        // No estimate means no sizing. Falling through to `best` silently would
        // be reporting a work-aware decision that was not one.
        const ranked = rankByCapacity(eligible, options);
        return {
          chosen: ranked[0]?.account ?? null,
          ranked,
          rejected,
          reason:
            'work-aware: no estimate of what the running work needs (not enough burn history), ' +
            'so the target was picked by headroom alone — this is NOT a sized choice',
          strategy: options.strategy,
        };
      }

      const bigEnough = eligible.filter((a) => a.headroomPct >= needed);
      if (bigEnough.length === 0) {
        const best = rankByCapacity(eligible, options)[0];
        return {
          chosen: null,
          ranked: rankByCapacity(eligible, options),
          rejected,
          reason:
            `work-aware: the running work is estimated to need ${needed.toFixed(0)}% headroom and ` +
            `the best available account has ${best?.account.headroomPct.toFixed(0) ?? '?'}%. ` +
            'Refusing to rotate onto an account that would run out mid-task; ' +
            'checkpoint and let a window reset instead.',
          strategy: options.strategy,
        };
      }

      const ranked = rankByCapacity(bigEnough, options);
      return {
        chosen: ranked[0]?.account ?? null,
        ranked,
        rejected: [
          ...rejected,
          ...eligible
            .filter((a) => a.headroomPct < needed)
            .map((account) => ({
              account,
              reason: `${account.headroomPct.toFixed(0)}% is under the ${needed.toFixed(0)}% the running work is estimated to need`,
            })),
        ],
        reason:
          `work-aware: ${bigEnough.length} account(s) have the estimated ${needed.toFixed(0)}% ` +
          'the running work needs; picked the largest of those',
        strategy: options.strategy,
      };
    }
  }
}

/**
 * Rank by what an account is worth over the horizon, not by a bare percentage.
 *
 * Ready accounts first, then the larger weekly budget, then the larger current
 * headroom, then the lower slot number so the order is deterministic and two
 * runs of the same reading never disagree.
 */
function rankByCapacity(accounts: AccountReading[], options: SelectOptions): Candidate[] {
  const context = {
    ...(options.horizonMs === undefined ? {} : { horizonMs: options.horizonMs }),
    ...(options.models === undefined ? {} : { models: options.models }),
    nowMs: (options.now?.() ?? new Date()).getTime(),
  };
  return [...accounts]
    .map((account) => ({ account, capacity: capacityOf(account, context) }))
    .sort((a, b) => {
      if (a.capacity.ready !== b.capacity.ready) return a.capacity.ready ? -1 : 1;
      if (a.capacity.rankPct !== b.capacity.rankPct) return b.capacity.rankPct - a.capacity.rankPct;
      if (a.capacity.nowPct !== b.capacity.nowPct) return b.capacity.nowPct - a.capacity.nowPct;
      return a.account.number - b.account.number;
    })
    .map(({ account, capacity }) => ({
      account,
      note: capacity.ready ? capacity.note : `${capacity.note} — NOT usable within the horizon`,
    }));
}

function finish(
  ranked: Candidate[],
  rejected: Selection['rejected'],
  strategy: Strategy,
  how: string,
): Selection {
  const chosen = ranked[0]?.account ?? null;
  return {
    chosen,
    ranked,
    rejected,
    reason:
      chosen === null
        ? `no account qualified under "${strategy}"`
        : `${strategy}: ${how} — chose #${chosen.number} (${ranked[0]?.note ?? ''})`,
    strategy,
  };
}

/** Distance from `from` to `to` going upward through the slot numbers. */
function wrapDistance(from: number, to: number): number {
  return to > from ? to - from : to + 1000 - from;
}

/** Sort key for reset time: sooner is smaller; unknown sorts last. */
function resetRank(account: AccountReading): number {
  if (account.bindingResetsAt === undefined) return Number.POSITIVE_INFINITY;
  const at = Date.parse(account.bindingResetsAt);
  return Number.isNaN(at) ? Number.POSITIVE_INFINITY : at;
}
