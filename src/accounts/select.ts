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
 */
import type { AccountReading, UsageReading } from '../core/usage.js';
import { headroomIsKnown } from '../core/usage.js';

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
      return finish(rankByHeadroom(eligible), rejected, options.strategy, 'most headroom first');

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
        const ranked = rankByHeadroom(eligible);
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
        const best = rankByHeadroom(eligible)[0];
        return {
          chosen: null,
          ranked: rankByHeadroom(eligible),
          rejected,
          reason:
            `work-aware: the running work is estimated to need ${needed.toFixed(0)}% headroom and ` +
            `the best available account has ${best?.account.headroomPct.toFixed(0) ?? '?'}%. ` +
            'Refusing to rotate onto an account that would run out mid-task; ' +
            'checkpoint and let a window reset instead.',
          strategy: options.strategy,
        };
      }

      const ranked = rankByHeadroom(bigEnough);
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

function rankByHeadroom(accounts: AccountReading[]): Candidate[] {
  return [...accounts]
    .sort((a, b) => b.headroomPct - a.headroomPct)
    .map((account) => ({
      account,
      note: `${account.headroomPct.toFixed(0)}% headroom on ${account.bindingWindow}`,
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
