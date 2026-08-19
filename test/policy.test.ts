/**
 * The weekly-priority policy, as a pure function.
 *
 * This is the redesign that came out of the 2026-08-19 duplicate-session
 * defect. rotorcc used to answer "the account is nearly out" with checkpoint,
 * switch the credential, and spawn a `claude --continue` — which is
 * abandon-and-replace, because a live process reads its credential once at
 * launch and cannot be hot-swapped. It put two operators on one worktree.
 *
 * The four rules under test:
 *   1. the WEEKLY window decides whether to move; the 5-hour one never does
 *   2. moving means choosing the account the NEXT session opens on
 *   3. when everything is spent, STOP — no rotate, no spawn, no queued intent
 *   4. never spawn a companion to a live session
 */
import { describe, expect, it } from 'vitest';

import { evaluatePolicy, renderStopNotice, weeklyHeadroom, windowsOf } from '../src/core/policy.js';
import type { AccountReading, UsageReading } from '../src/core/usage.js';
import { testConfig } from './helpers.js';

interface Windows {
  fiveHour?: number | null;
  sevenDay?: number | null;
  model?: { name: string; headroomPct: number };
}

function account(
  number: number,
  windows: Windows,
  extra: Partial<AccountReading> = {},
): AccountReading {
  const list = [];
  if (windows.fiveHour !== null && windows.fiveHour !== undefined) {
    list.push({ name: '5h', headroomPct: windows.fiveHour, resetsAt: '2026-08-19T23:00:00Z' });
  }
  if (windows.sevenDay !== null && windows.sevenDay !== undefined) {
    list.push({ name: '7d', headroomPct: windows.sevenDay, resetsAt: '2026-08-24T09:00:00Z' });
  }
  if (windows.model !== undefined) {
    list.push({
      name: windows.model.name,
      headroomPct: windows.model.headroomPct,
      resetsAt: '2026-08-24T09:00:00Z',
    });
  }
  const binding = list.reduce<(typeof list)[number] | undefined>(
    (worst, w) => (worst === undefined || w.headroomPct < worst.headroomPct ? w : worst),
    undefined,
  );
  return {
    number,
    email: `a${number}@example.com`,
    active: false,
    headroomPct: binding?.headroomPct ?? 0,
    headroomKnown: true,
    bindingWindow: binding?.name ?? 'unknown',
    bindingResetsAt: binding?.resetsAt,
    windows: list,
    stale: false,
    usageAgeMs: 1000,
    ...extra,
  };
}

function unmeasured(number: number, reason = 'quota read failed'): AccountReading {
  return {
    number,
    email: `a${number}@example.com`,
    active: false,
    headroomPct: 0,
    headroomKnown: false,
    unknownReason: reason,
    bindingWindow: 'unknown',
    windows: [],
    stale: true,
    usageAgeMs: null,
  };
}

function reading(accounts: AccountReading[], active = 1): UsageReading {
  return {
    observedAt: '2026-08-19T12:00:00Z',
    activeAccountNumber: active,
    accounts: accounts.map((a) => ({ ...a, active: a.number === active })),
    source: 'native',
  };
}

const config = testConfig();

describe('windowsOf', () => {
  it('separates the weekly windows from the 5-hour one', () => {
    const view = windowsOf(
      account(1, { fiveHour: 4, sevenDay: 60, model: { name: 'Opus', headroomPct: 20 } }),
    );
    expect(view.fiveHourPct).toBe(4);
    expect(view.weeklyPct).toBe(60);
    expect(view.modelPct).toBe(20);
    expect(view.modelName).toBe('Opus');
  });

  it('counts every per-model window when none are named', () => {
    const weekly = weeklyHeadroom(
      account(1, { fiveHour: 90, sevenDay: 60, model: { name: 'Opus', headroomPct: 3 } }),
    );
    // A per-model cap folds into the WEEK, because that is what it is: a slice
    // of the same week's budget.
    expect(weekly.pct).toBe(3);
    expect(weekly.window).toBe('Opus');
  });

  it('counts only the named model when one is given', () => {
    const weekly = weeklyHeadroom(
      account(1, { fiveHour: 90, sevenDay: 60, model: { name: 'Opus', headroomPct: 3 } }),
      ['Fable'],
    );
    expect(weekly.pct).toBe(60);
  });

  it('reports null rather than a number when the weekly window is unknown', () => {
    expect(weeklyHeadroom(unmeasured(1)).pct).toBeNull();
  });
});

describe('rule 1 — the weekly window is the priority signal', () => {
  it('does NOT move for a spent 5-hour window when the week is healthy', () => {
    const action = evaluatePolicy({
      reading: reading([
        account(1, { fiveHour: 2, sevenDay: 85 }),
        account(2, { fiveHour: 99, sevenDay: 99 }),
      ]),
      config,
      sessionAlive: true,
    });
    // Burning a second account's WEEK to escape a window that refills in hours
    // is the trade this rule exists to refuse.
    expect(action.kind).toBe('checkpoint');
    expect(action.kind === 'checkpoint' && action.reason).toContain('weekly window is healthy');
  });

  it('moves when the WEEKLY window is spent, even with 5 hours to spare', () => {
    const action = evaluatePolicy({
      reading: reading([
        account(1, { fiveHour: 95, sevenDay: 3 }),
        account(2, { fiveHour: 50, sevenDay: 80 }),
      ]),
      config,
      sessionAlive: true,
    });
    expect(action.kind).toBe('handover');
  });

  it('warns without acting in the weekly warn band', () => {
    const action = evaluatePolicy({
      reading: reading([
        account(1, { fiveHour: 95, sevenDay: 15 }),
        account(2, { fiveHour: 90, sevenDay: 90 }),
      ]),
      config,
      sessionAlive: true,
    });
    expect(action.kind).toBe('warn');
  });

  it('does nothing at all when both windows are healthy', () => {
    const action = evaluatePolicy({
      reading: reading([
        account(1, { fiveHour: 80, sevenDay: 80 }),
        account(2, { fiveHour: 90, sevenDay: 90 }),
      ]),
      config,
      sessionAlive: true,
    });
    expect(action.kind).toBe('none');
  });

  it('refuses to act on an unknown weekly figure, and says so', () => {
    const action = evaluatePolicy({
      reading: reading([unmeasured(1), account(2, { fiveHour: 90, sevenDay: 90 })]),
      config,
      sessionAlive: true,
    });
    // Not 'none' (which would imply it looked and was satisfied) and not a
    // handover (which would be acting on a number it does not have).
    expect(action.kind).toBe('warn');
    expect(action.kind === 'warn' && action.reason).toContain('could not be measured');
  });
});

describe('rule 2 — handover chooses by weekly headroom', () => {
  it('picks the account with the most WEEK left, not the most 5 hours', () => {
    const action = evaluatePolicy({
      reading: reading([
        account(1, { fiveHour: 50, sevenDay: 2 }),
        account(2, { fiveHour: 99, sevenDay: 8 }),
        account(3, { fiveHour: 20, sevenDay: 75 }),
      ]),
      config,
      sessionAlive: true,
    });
    expect(action.kind === 'handover' && action.slot).toBe(3);
  });

  it('says plainly that the running session is not being interrupted', () => {
    const action = evaluatePolicy({
      reading: reading([
        account(1, { fiveHour: 50, sevenDay: 2 }),
        account(3, { fiveHour: 20, sevenDay: 75 }),
      ]),
      config,
      sessionAlive: true,
    });
    expect(action.kind === 'handover' && action.reason).toContain('NOT being interrupted');
  });

  it('says it takes effect immediately when nothing is running', () => {
    const action = evaluatePolicy({
      reading: reading([
        account(1, { fiveHour: 50, sevenDay: 2 }),
        account(3, { fiveHour: 20, sevenDay: 75 }),
      ]),
      config,
      sessionAlive: false,
    });
    expect(action.kind === 'handover' && action.reason).toContain('takes effect immediately');
  });

  it('never targets an account whose weekly headroom is unknown', () => {
    const action = evaluatePolicy({
      reading: reading([account(1, { fiveHour: 50, sevenDay: 2 }), unmeasured(2)]),
      config,
      sessionAlive: true,
    });
    // Unknown is not a candidate, so there is nowhere to go: STOP.
    expect(action.kind).toBe('stop');
  });

  it('never targets a disabled account', () => {
    const action = evaluatePolicy({
      reading: reading([
        account(1, { fiveHour: 50, sevenDay: 2 }),
        account(2, { fiveHour: 90, sevenDay: 90 }, { disabled: true }),
      ]),
      config,
      sessionAlive: true,
    });
    expect(action.kind).toBe('stop');
    expect(action.kind === 'stop' && action.accounts.some((a) => a.why.includes('disabled'))).toBe(
      true,
    );
  });

  it('never targets an API-key account', () => {
    const action = evaluatePolicy({
      reading: reading([
        account(1, { fiveHour: 50, sevenDay: 2 }),
        account(2, { fiveHour: 90, sevenDay: 90 }, { kind: 'api-key' }),
      ]),
      config,
      sessionAlive: true,
    });
    expect(action.kind).toBe('stop');
    expect(
      action.kind === 'stop' && action.accounts.some((a) => a.why.includes('bills per token')),
    ).toBe(true);
  });
});

describe('rule 3 — when everything is spent, STOP', () => {
  const exhausted = reading([
    account(1, { fiveHour: 40, sevenDay: 3 }),
    account(2, { fiveHour: 40, sevenDay: 4 }),
    account(3, { fiveHour: 40, sevenDay: 1 }),
  ]);

  it('returns stop, not a handover onto the least-bad account', () => {
    const action = evaluatePolicy({ reading: exhausted, config, sessionAlive: true });
    // A handover onto an account with 4% of its week left just moves the
    // problem to the next session start.
    expect(action.kind).toBe('stop');
  });

  it('names every account, including the one in use', () => {
    const action = evaluatePolicy({ reading: exhausted, config, sessionAlive: true });
    if (action.kind !== 'stop') throw new Error('expected stop');
    expect(action.accounts.map((a) => a.slot).sort()).toEqual([1, 2, 3]);
    expect(action.accounts.find((a) => a.slot === 1)?.why).toContain('the account in use');
  });

  it("carries each account's reset time, which is the only actionable fact left", () => {
    const action = evaluatePolicy({ reading: exhausted, config, sessionAlive: true });
    if (action.kind !== 'stop') throw new Error('expected stop');
    expect(action.accounts.every((a) => a.resetsAt !== null)).toBe(true);
  });

  it('distinguishes an unmeasured account from an empty one in the notice', () => {
    const action = evaluatePolicy({
      reading: reading([account(1, { fiveHour: 40, sevenDay: 3 }), unmeasured(2, 'http-429')]),
      config,
      sessionAlive: true,
    });
    if (action.kind !== 'stop') throw new Error('expected stop');
    const notice = renderStopNotice(action);
    // "we could not read this" and "this is empty" mean different things, and
    // only one of them means waiting will help.
    expect(notice).toContain('unknown');
    expect(notice).toContain('http-429');
  });

  it('the notice tells the operator what to do next', () => {
    const action = evaluatePolicy({ reading: exhausted, config, sessionAlive: true });
    if (action.kind !== 'stop') throw new Error('expected stop');
    const notice = renderStopNotice(action);
    expect(notice).toContain('rotorcc has STOPPED');
    expect(notice).toContain('No rotation was performed');
    expect(notice).toContain('wait for the earliest reset');
    expect(notice).toContain('rotorcc accounts add');
  });
});

describe('rotation.enabled = false', () => {
  const disabled = { ...config, rotation: { enabled: false } };

  it('does not queue a handover, but still names where to go', () => {
    const action = evaluatePolicy({
      reading: reading([
        account(1, { fiveHour: 50, sevenDay: 2 }),
        account(3, { fiveHour: 20, sevenDay: 75 }),
      ]),
      config: disabled,
      sessionAlive: true,
    });
    // An intent SessionStart would act on is still rotorcc changing the account
    // by itself, just later. Refusing to act is not a reason to refuse to
    // inform, so the account is still named.
    expect(action.kind).toBe('checkpoint');
    expect(action.kind === 'checkpoint' && action.reason).toContain('rotation is disabled');
    expect(action.kind === 'checkpoint' && action.reason).toContain('slot 3');
  });

  it('still STOPS when everything is spent', () => {
    const action = evaluatePolicy({
      reading: reading([
        account(1, { fiveHour: 40, sevenDay: 3 }),
        account(2, { fiveHour: 40, sevenDay: 2 }),
      ]),
      config: disabled,
      sessionAlive: true,
    });
    expect(action.kind).toBe('stop');
  });
});

describe('no active account', () => {
  it('evaluates nothing rather than guessing which account it is', () => {
    const action = evaluatePolicy({
      reading: {
        observedAt: '2026-08-19T12:00:00Z',
        activeAccountNumber: null,
        accounts: [account(1, { fiveHour: 3, sevenDay: 3 })],
        source: 'native',
        activeDetectionReason: 'the live credential matches no managed account',
      },
      config,
      sessionAlive: true,
    });
    expect(action.kind).toBe('none');
    expect(action.kind === 'none' && action.reason).toContain('matches no managed account');
  });
});
