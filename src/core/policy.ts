/**
 * The rotation policy, restated after the 2026-08-19 duplicate-session defect.
 *
 * Four rules, in the order they take precedence.
 *
 * **1. The weekly window is the priority signal.**
 * Both windows are tracked, but they mean different things. The 5-hour window
 * refills several times a day; burning it is inconvenient. The 7-day window is
 * the real budget, and spending it early is the thing an operator actually
 * regrets. So the weekly window drives the decision to move, and the 5-hour
 * window must never on its own cause a switch that burns weekly quota we will
 * want later in the week. Concretely: a 5h window at 2% on an account whose
 * weekly is healthy is a reason to *wait four hours*, not a reason to consume
 * another account's week.
 *
 * **2. Switching means changing the account the NEXT session opens on.**
 * Never interrupting a live one. A running Claude Code process read its
 * credential at launch and cannot be hot-swapped; the old "checkpoint, switch,
 * spawn a successor" model was abandon-and-replace, and it put two operators on
 * one worktree. See `nextSession.ts`.
 *
 * **3. When every account is spent, STOP.**
 * Do not rotate, do not spawn, do not queue an intent. Say so loudly, name each
 * account with its headroom and reset time, and wait for the human. Rotating
 * onto an exhausted account produces a session that dies in a minute; spawning
 * a successor with nowhere to go produces a session that cannot start. Both are
 * worse than stopping, and stopping is the only one an operator can act on.
 *
 * **4. Never spawn a companion.**
 * A successor replaces a session that is genuinely dead — process gone — and
 * nothing else. For a live session near a limit: warn, checkpoint, record the
 * intent for next time, and let the operator or the natural end of the session
 * carry it over.
 *
 * Everything here is a pure function of a reading, the config and the clock, so
 * the policy that must never misfire is the part that can be exhaustively
 * tested.
 */
import type { Config } from '../config/schema.js';
import {
  type AccountReading,
  type UsageReading,
  activeAccount,
  formatWindowsUsed,
  headroomIsKnown,
} from './usage.js';

/** A window's headroom, or null when the account did not report it. */
export function windowHeadroom(account: AccountReading, name: string): number | null {
  if (!headroomIsKnown(account)) return null;
  const window = account.windows.find((w) => w.name === name);
  return window?.headroomPct ?? null;
}

export interface WindowView {
  /** Headroom on the 7-day window, or null when unknown. */
  weeklyPct: number | null;
  /** Headroom on the 5-hour window, or null when unknown. */
  fiveHourPct: number | null;
  /** Headroom on the worst per-model weekly window that is counted, or null. */
  modelPct: number | null;
  /** The name of that model window. */
  modelName: string | null;
}

/**
 * Split an account's windows into the two that mean different things.
 *
 * Per-model weekly caps are folded in with the weekly window rather than the
 * 5-hour one, because that is what they are: a slice of the same week's budget.
 */
export function windowsOf(account: AccountReading, models: string[] = []): WindowView {
  const wanted = models.map((m) => m.toLowerCase());
  const matchAll = wanted.length === 0 || wanted.includes('all');

  let modelPct: number | null = null;
  let modelName: string | null = null;
  for (const window of account.windows) {
    if (window.name === '5h' || window.name === '7d') continue;
    if (!matchAll && !wanted.includes(window.name.toLowerCase())) continue;
    if (modelPct === null || window.headroomPct < modelPct) {
      modelPct = window.headroomPct;
      modelName = window.name;
    }
  }

  return {
    weeklyPct: windowHeadroom(account, '7d'),
    fiveHourPct: windowHeadroom(account, '5h'),
    modelPct,
    modelName,
  };
}

/**
 * The weekly picture for an account: the lower of the account-wide weekly
 * window and the worst counted per-model weekly window.
 *
 * Null when neither is known — and null is never treated as healthy.
 */
export function weeklyHeadroom(
  account: AccountReading,
  models: string[] = [],
): { pct: number | null; window: string } {
  const view = windowsOf(account, models);
  const candidates: Array<[number, string]> = [];
  if (view.weeklyPct !== null) candidates.push([view.weeklyPct, '7d']);
  if (view.modelPct !== null && view.modelName !== null) {
    candidates.push([view.modelPct, view.modelName]);
  }
  if (candidates.length === 0) return { pct: null, window: 'unknown' };
  const worst = candidates.reduce((a, b) => (b[0] < a[0] ? b : a));
  return { pct: worst[0], window: worst[1] };
}

export type PolicyAction =
  /** Nothing to do. */
  | { kind: 'none'; reason: string }
  /** Tell the operator; do not act. */
  | { kind: 'warn'; reason: string }
  /** Save everything now; still do not switch. */
  | { kind: 'checkpoint'; reason: string }
  /**
   * Record that the NEXT session should open on `slot`. Never interrupts the
   * running one.
   */
  | { kind: 'handover'; slot: number; reason: string; window: string }
  /**
   * Every account is spent. Stop, tell the human, and wait. No rotation, no
   * successor, no queued intent.
   */
  | { kind: 'stop'; reason: string; accounts: ExhaustedAccount[] };

export interface ExhaustedAccount {
  slot: number;
  label: string;
  /** Null when it could not be measured — which is not the same as spent. */
  headroomPct: number | null;
  window: string;
  resetsAt: string | null;
  /** Why it is not a candidate, in words. */
  why: string;
  /**
   * Both windows, formatted, so the notice that stops the machine says which
   * kind of exhausted each account is. "Out for forty minutes" and "out for the
   * week" produce completely different next moves from the human this notice is
   * addressed to, and a single figure cannot tell them apart.
   */
  windows?: string;
}

export interface PolicyInput {
  reading: UsageReading;
  config: Config;
  /** True when a session is currently alive on this machine. */
  sessionAlive: boolean;
}

/**
 * Evaluate the policy.
 *
 * Deliberately returns ONE action. A caller that has to work out which of three
 * returned things takes precedence is a caller that will get it wrong.
 */
export function evaluatePolicy(input: PolicyInput): PolicyAction {
  const { reading, config } = input;
  const models = config.models;
  const active = activeAccount(reading);

  if (active === null) {
    return {
      kind: 'none',
      reason:
        reading.activeDetectionReason ??
        'no active account could be identified, so there is nothing to evaluate',
    };
  }

  const activeWeekly = weeklyHeadroom(active, models);
  const activeView = windowsOf(active, models);

  // Candidates: measured, not the active one, not disabled, not an API-key
  // account, and with weekly headroom above the floor. Weekly, not binding —
  // an account whose 5h window happens to be low right now is still a perfectly
  // good place for the NEXT session, which by definition starts later.
  const candidates: AccountReading[] = [];
  const rejected: ExhaustedAccount[] = [];

  for (const account of reading.accounts) {
    if (account.number === active.number) continue;
    const label = account.alias ?? account.email ?? `slot ${account.number}`;
    const weekly = weeklyHeadroom(account, models);

    if (!headroomIsKnown(account)) {
      rejected.push({
        slot: account.number,
        label,
        headroomPct: null,
        window: 'unknown',
        resetsAt: null,
        windows: formatWindowsUsed(account),
        why: account.unknownReason ?? 'not measured',
      });
      continue;
    }
    if (account.kind === 'api-key') {
      rejected.push({
        slot: account.number,
        label,
        headroomPct: null,
        window: 'n/a',
        resetsAt: null,
        windows: formatWindowsUsed(account),
        why: 'API-key account: bills per token, never an automatic target',
      });
      continue;
    }
    if (account.disabled === true) {
      rejected.push({
        slot: account.number,
        label,
        headroomPct: weekly.pct,
        window: weekly.window,
        resetsAt: account.bindingResetsAt ?? null,
        windows: formatWindowsUsed(account),
        why: 'disabled by the operator',
      });
      continue;
    }
    if (weekly.pct === null || weekly.pct <= config.weeklyRotatePct) {
      rejected.push({
        slot: account.number,
        label,
        headroomPct: weekly.pct,
        window: weekly.window,
        resetsAt: account.bindingResetsAt ?? null,
        windows: formatWindowsUsed(account),
        why:
          weekly.pct === null
            ? 'weekly headroom unknown'
            : `weekly window at ${weekly.pct.toFixed(0)}% headroom, at or under the ${config.weeklyRotatePct}% floor`,
      });
      continue;
    }
    candidates.push(account);
  }

  // ---------------------------------------------------------------- rule 1
  // The weekly window decides whether we want to move at all.
  const weeklyLow = activeWeekly.pct !== null && activeWeekly.pct <= config.weeklyRotatePct;
  const weeklyWarn = activeWeekly.pct !== null && activeWeekly.pct <= config.weeklyWarnPct;
  const weeklyUnknown = activeWeekly.pct === null;

  if (!weeklyLow) {
    // The weekly budget is fine. A low 5-hour window is NOT a reason to spend
    // another account's week — it is a reason to wait for the 5h window to
    // refill, which it does several times a day.
    if (activeView.fiveHourPct !== null && activeView.fiveHourPct <= config.thresholds.softPct) {
      return {
        kind: 'checkpoint',
        reason:
          `the 5-hour window is down to ${activeView.fiveHourPct.toFixed(0)}% but the weekly ` +
          `window is healthy at ${activeWeekly.pct?.toFixed(0) ?? '?'}%. Saving everything and ` +
          "staying put: burning a second account's week to escape a window that refills in " +
          'hours is a bad trade.',
      };
    }
    if (weeklyWarn) {
      return {
        kind: 'warn',
        reason:
          `weekly window at ${activeWeekly.pct?.toFixed(0) ?? '?'}% headroom on ` +
          `${activeWeekly.window}; approaching the ${config.weeklyRotatePct}% handover point`,
      };
    }
    if (weeklyUnknown) {
      return {
        kind: 'warn',
        reason:
          "the active account's weekly headroom could not be measured, so rotorcc cannot tell " +
          'whether a handover is needed. It will not act on a number it does not have.',
      };
    }
    return {
      kind: 'none',
      reason: `weekly headroom ${activeWeekly.pct?.toFixed(0) ?? '?'}% on ${activeWeekly.window}; nothing to do`,
    };
  }

  // ---------------------------------------------------------------- rule 3
  // The weekly window is spent. Is there anywhere to go?
  if (candidates.length === 0) {
    const activeLabel = active.alias ?? active.email ?? `slot ${active.number}`;
    const roster = [
      {
        slot: active.number,
        label: activeLabel,
        headroomPct: activeWeekly.pct,
        window: activeWeekly.window,
        resetsAt: active.bindingResetsAt ?? null,
        windows: formatWindowsUsed(active),
        why: 'the account in use',
      },
      ...rejected,
    ];

    // "Every account is spent" and "I could not measure some of them" are
    // different statements, and only the first justifies declaring the machine
    // finished. An account rotorcc could not read might be sitting at 90% — the
    // 2026-08-19 outage was exactly this shape, where an unreadable account was
    // treated as a fact about quota rather than a fact about the reader.
    //
    // So: stop ONLY when every alternative was measured and every measurement
    // was spent. When any of them is merely unknown, say that instead.
    const unmeasured = rejected.filter((r) => r.headroomPct === null && r.window === 'unknown');
    if (unmeasured.length > 0) {
      return {
        kind: 'checkpoint',
        reason:
          `the weekly window is down to ${activeWeekly.pct?.toFixed(0) ?? '?'}% and rotorcc could ` +
          `not measure ${unmeasured.length} of the other account(s) ` +
          `(${unmeasured.map((u) => `slot ${u.slot}: ${u.why}`).join('; ')}). ` +
          'It will NOT declare the machine out of quota on a reading it does not have, and it ' +
          'will not hand over to an account it cannot see. Everything has been checkpointed; ' +
          'run "rotorcc accounts --force" to retry the read.',
      };
    }

    return {
      kind: 'stop',
      reason:
        `every account is at or below ${config.weeklyRotatePct}% weekly headroom. rotorcc is ` +
        'NOT rotating and NOT starting anything. Work already committed and pushed is safe; ' +
        'this needs a human.',
      accounts: roster,
    };
  }

  // ---------------------------------------------------------------- rule 2
  // There is somewhere to go. Record it for the next session; do not interrupt.
  const best = candidates.reduce((a, b) =>
    (weeklyHeadroom(b, models).pct ?? 0) > (weeklyHeadroom(a, models).pct ?? 0) ? b : a,
  );
  const bestWeekly = weeklyHeadroom(best, models);
  const bestLabel = best.alias ?? best.email ?? `slot ${best.number}`;

  if (!config.rotation.enabled) {
    // The operator has said this machine does not change accounts by itself.
    // That applies to a queued handover exactly as much as to a live switch —
    // recording an intent that `SessionStart` would act on is still rotorcc
    // changing the account on its own, just later. It stays a pure durability
    // tool: watch, warn, checkpoint, and name the account a human should move
    // to when they choose to.
    return {
      kind: 'checkpoint',
      reason:
        `weekly window down to ${activeWeekly.pct?.toFixed(0) ?? '?'}% on ${activeWeekly.window}, ` +
        `and ${bestLabel} (slot ${best.number}) has ${bestWeekly.pct?.toFixed(0) ?? '?'}% left — ` +
        'but rotation is disabled in this configuration, so nothing was queued. ' +
        'Everything has been checkpointed; switch by hand when you are ready.',
    };
  }

  return {
    kind: 'handover',
    slot: best.number,
    window: activeWeekly.window,
    reason:
      `weekly window down to ${activeWeekly.pct?.toFixed(0) ?? '?'}% on ${activeWeekly.window}. ` +
      `The next session will open on ${bestLabel} (slot ${best.number}, ` +
      `${bestWeekly.pct?.toFixed(0) ?? '?'}% weekly headroom). ` +
      (input.sessionAlive
        ? 'The running session is NOT being interrupted — it keeps its account until it ends.'
        : 'No session is running, so this takes effect immediately.'),
  };
}

/**
 * The message an operator sees when everything is spent.
 *
 * Written as a block of plain text rather than a log line because this is the
 * one moment rotorcc has nothing useful to do and must make sure a human knows.
 * Every account is named with its number, its headroom and when it comes back —
 * an unmeasured one says so rather than being omitted, because "we could not
 * read this one" is materially different from "this one is empty" and only one
 * of them means waiting will help.
 */
export function renderStopNotice(action: Extract<PolicyAction, { kind: 'stop' }>): string {
  const lines: string[] = [];
  lines.push('');
  lines.push('  ┌────────────────────────────────────────────────────────────────────┐');
  lines.push('  │  rotorcc has STOPPED. Every account is out of weekly quota.        │');
  lines.push('  └────────────────────────────────────────────────────────────────────┘');
  lines.push('');
  lines.push('  No rotation was performed. No session was started. Nothing is running');
  lines.push('  that will consume more quota.');
  lines.push('');
  lines.push('  accounts — how much of each window has been SPENT');
  for (const account of action.accounts) {
    const resets =
      account.resetsAt === null
        ? 'reset time unknown'
        : `resets ${account.resetsAt.slice(0, 16).replace('T', ' ')}`;
    lines.push(`    ${String(account.slot).padEnd(3)} ${account.label}`);
    // Both windows, then which one binds. The old form printed one figure as
    // "N% left", which inverted the convention every other surface uses and
    // said nothing about the window that was not chosen.
    lines.push(`        ${account.windows ?? 'window spend not recorded'}`);
    lines.push(
      `        ${account.window === 'unknown' ? 'binding window unknown' : `${account.window} binds`} · ${resets}`,
    );
    lines.push(`        ${account.why}`);
  }
  lines.push('');
  lines.push('  What to do');
  lines.push('    · wait for the earliest reset above, then start a session normally;');
  lines.push('    · or add another account:  rotorcc accounts add');
  lines.push('    · or check what is unsaved: rotorcc status');
  lines.push('');
  return lines.join('\n');
}
