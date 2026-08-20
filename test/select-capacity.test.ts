/**
 * Ranking rotation targets by what they are worth, not by a bare percentage.
 *
 * The defect this file exists for: `headroomPct` is the BINDING window's
 * headroom, and the binding window differs per account, so sorting on it
 * compares "10% of a week" with "1% of five hours" as though they were the same
 * number. The first case below is the real reading that exposed it.
 */
import { describe, expect, it } from 'vitest';

import { DEFAULT_HORIZON_MS, capacityOf, selectTarget } from '../src/accounts/select.js';
import { pickTarget } from '../src/core/decide.js';
import type { AccountReading, UsageReading } from '../src/core/usage.js';
import { testConfig } from './helpers.js';

const NOW = Date.parse('2026-08-19T23:00:00Z');
const now = (): Date => new Date(NOW);

/** An account described by its windows, with the binding one worked out here. */
function account(
  number: number,
  windows: Array<{ name: string; headroomPct: number; resetsInMinutes?: number }>,
  overrides: Partial<AccountReading> = {},
): AccountReading {
  const withReset = windows.map((w) => ({
    name: w.name,
    headroomPct: w.headroomPct,
    resetsAt:
      w.resetsInMinutes === undefined
        ? undefined
        : new Date(NOW + w.resetsInMinutes * 60_000).toISOString(),
  }));
  const binding = withReset.reduce((a, b) => (b.headroomPct < a.headroomPct ? b : a));
  return {
    number,
    email: `a${number}@example.com`,
    active: false,
    headroomPct: binding.headroomPct,
    headroomKnown: true,
    bindingWindow: binding.name,
    ...(binding.resetsAt === undefined ? {} : { bindingResetsAt: binding.resetsAt }),
    windows: withReset,
    stale: false,
    ...overrides,
  };
}

function reading(accounts: AccountReading[], activeNumber: number | null = null): UsageReading {
  return {
    observedAt: new Date(NOW).toISOString(),
    activeAccountNumber: activeNumber,
    accounts,
    source: 'native',
  };
}

describe('capacityOf', () => {
  it('ranks on the weekly budget, not on whichever window happens to bind', () => {
    const weeklyConstrained = account(1, [
      { name: '5h', headroomPct: 100 },
      { name: '7d', headroomPct: 10, resetsInMinutes: 5 * 24 * 60 },
    ]);
    const rateConstrained = account(2, [
      { name: '5h', headroomPct: 1, resetsInMinutes: 20 },
      { name: '7d', headroomPct: 28, resetsInMinutes: 3 * 24 * 60 },
    ]);

    const a = capacityOf(weeklyConstrained, { nowMs: NOW });
    const b = capacityOf(rateConstrained, { nowMs: NOW });

    // The naive sort would have put A first: 10% beats 1%.
    expect(weeklyConstrained.headroomPct).toBeGreaterThan(rateConstrained.headroomPct);
    // The ranking key does not.
    expect(b.rankPct).toBeGreaterThan(a.rankPct);
    expect(b.ready).toBe(true);
  });

  it('calls an account with a spent 5-hour window unready past the horizon', () => {
    const late = account(3, [
      { name: '5h', headroomPct: 0, resetsInMinutes: 10 * 60 },
      { name: '7d', headroomPct: 60 },
    ]);
    expect(capacityOf(late, { nowMs: NOW }).ready).toBe(false);
    expect(capacityOf(late, { nowMs: NOW, horizonMs: 11 * 3_600_000 }).ready).toBe(true);
  });

  it('reads the 5-hour reset from the 5-hour window, not from whichever binds', () => {
    // Binding and 5-hour are usually the same window, because a spent 5-hour
    // window is usually the smallest number. They come apart when the binding
    // window is chosen under a per-model filter (`config.models`), which can
    // leave the week or a model cap binding while the rate limit is spent.
    //
    // Reading the reset off `bindingResetsAt` there would put the week's reset
    // — days away — into a readiness question about a rate limit that clears in
    // twenty minutes, and rank a perfectly usable account below everything.
    const weekBinds: AccountReading = {
      ...account(8, [
        { name: '5h', headroomPct: 0, resetsInMinutes: 20 },
        { name: '7d', headroomPct: 4, resetsInMinutes: 5 * 24 * 60 },
      ]),
      bindingWindow: '7d',
      bindingResetsAt: new Date(NOW + 5 * 24 * 60 * 60_000).toISOString(),
      headroomPct: 4,
    };

    const capacity = capacityOf(weekBinds, { nowMs: NOW });
    expect(capacity.bindingResetsInMs).toBeGreaterThan(24 * 3_600_000);
    expect(capacity.ready).toBe(true);
    expect(capacity.note).toContain('resets in 20m');
  });

  it('reports BOTH windows as used, like every other surface', () => {
    const note = capacityOf(
      account(9, [
        { name: '5h', headroomPct: 40 },
        { name: '7d', headroomPct: 30 },
      ]),
      { nowMs: NOW },
    ).note;
    // Both, always. A candidate list that names only the window that binds
    // makes the reader guess at the other one, which is the mistake that
    // produced the 2026-08-19 misreport.
    expect(note).toContain('5h 60% used');
    expect(note).toContain('7d 70% used');
    expect(note).toContain('7d binds');
    // Headroom, the inverted convention, must not appear anywhere in it.
    expect(note).not.toContain('30% on');
    expect(note).not.toContain('40% on');
  });

  it('treats an unknown reset time as unready, never as "back soon"', () => {
    const noReset = account(4, [
      { name: '5h', headroomPct: 0 },
      { name: '7d', headroomPct: 60 },
    ]);
    const capacity = capacityOf(noReset, { nowMs: NOW });
    expect(capacity.bindingResetsInMs).toBeNull();
    expect(capacity.ready).toBe(false);
    expect(capacity.note).toContain('reset time is unknown');
  });

  it('falls back to the binding window when there is no weekly reading, and says so', () => {
    const noWeekly = account(5, [{ name: '5h', headroomPct: 40, resetsInMinutes: 30 }]);
    const capacity = capacityOf(noWeekly, { nowMs: NOW });
    expect(capacity.weeklyPct).toBeNull();
    expect(capacity.rankPct).toBe(40);
    expect(capacity.note).toContain('no weekly reading');
  });

  it('folds a per-model weekly cap into the weekly figure', () => {
    const capped = account(6, [
      { name: '5h', headroomPct: 90 },
      { name: '7d', headroomPct: 70 },
      { name: 'Fable', headroomPct: 12 },
    ]);
    expect(capacityOf(capped, { nowMs: NOW, models: ['all'] }).weeklyPct).toBe(12);
    // Not counted when the operator did not ask for that model.
    expect(capacityOf(capped, { nowMs: NOW, models: ['opus'] }).weeklyPct).toBe(70);
  });

  it('has a horizon long enough to be about this session, not about tomorrow', () => {
    expect(DEFAULT_HORIZON_MS).toBe(4 * 60 * 60 * 1000);
  });
});

describe('selectTarget ranking', () => {
  it('prefers the week it will not regret over the window that binds today', () => {
    const selection = selectTarget(
      reading(
        [
          account(
            1,
            [
              { name: '5h', headroomPct: 50 },
              { name: '7d', headroomPct: 90 },
            ],
            { active: true },
          ),
          account(2, [
            { name: '5h', headroomPct: 100 },
            { name: '7d', headroomPct: 10, resetsInMinutes: 5 * 24 * 60 },
          ]),
          account(3, [
            { name: '5h', headroomPct: 1, resetsInMinutes: 20 },
            { name: '7d', headroomPct: 28, resetsInMinutes: 3 * 24 * 60 },
          ]),
        ],
        1,
      ),
      { strategy: 'best', activeNumber: 1, minHeadroomPct: 0, now },
    );

    expect(selection.chosen?.number).toBe(3);
    // The note reports USED on BOTH windows, like every other surface. This is
    // the exact account from the incident: its 5-hour window is 99% spent and
    // its week is only 72% spent, and a note that showed one of those numbers
    // alone is what made it look finished.
    expect(selection.ranked[0]?.note).toContain('5h 99% used');
    expect(selection.ranked[0]?.note).toContain('7d 72% used');
    expect(selection.ranked[0]?.note).toContain('5h binds');
    expect(selection.ranked[0]?.note).not.toMatch(/\d+% on \w+ now$/);
    expect(selection.reason).toContain('weekly budget');
  });

  it('ranks an account that cannot be used inside the horizon below one that can', () => {
    const selection = selectTarget(
      reading([
        // Bigger week, but its rate limit does not clear for ten hours.
        account(2, [
          { name: '5h', headroomPct: 0, resetsInMinutes: 10 * 60 },
          { name: '7d', headroomPct: 80 },
        ]),
        // Smaller week, usable right now.
        account(3, [
          { name: '5h', headroomPct: 60 },
          { name: '7d', headroomPct: 40 },
        ]),
      ]),
      { strategy: 'best', activeNumber: null, minHeadroomPct: 0, now },
    );

    expect(selection.chosen?.number).toBe(3);
    // The unusable one is still ranked and still offered — it is a worse target,
    // not a disqualified one.
    expect(selection.ranked.map((r) => r.account.number)).toEqual([3, 2]);
    expect(selection.ranked[1]?.note).toContain('NOT usable within the horizon');
  });

  it('is deterministic when two accounts are genuinely equivalent', () => {
    const build = (): UsageReading =>
      reading([
        account(7, [
          { name: '5h', headroomPct: 50 },
          { name: '7d', headroomPct: 50 },
        ]),
        account(2, [
          { name: '5h', headroomPct: 50 },
          { name: '7d', headroomPct: 50 },
        ]),
      ]);
    const options = { strategy: 'best' as const, activeNumber: null, minHeadroomPct: 0, now };
    expect(selectTarget(build(), options).chosen?.number).toBe(2);
    expect(selectTarget(build(), options).chosen?.number).toBe(2);
  });

  it('still refuses an unmeasured account, however good the rest of it looks', () => {
    const unknown = account(2, [{ name: '5h', headroomPct: 0 }], {
      headroomKnown: false,
      unknownReason: 'quota read failed: http-429',
      stale: true,
    });
    const selection = selectTarget(reading([unknown]), {
      strategy: 'best',
      activeNumber: null,
      minHeadroomPct: 0,
      now,
    });
    expect(selection.chosen).toBeNull();
    expect(selection.rejected[0]?.reason).toContain('http-429');
  });

  it('work-aware still sizes the target, and still refuses when nothing fits', () => {
    const accounts = [
      account(2, [
        { name: '5h', headroomPct: 30 },
        { name: '7d', headroomPct: 30 },
      ]),
      account(3, [
        { name: '5h', headroomPct: 20 },
        { name: '7d', headroomPct: 20 },
      ]),
    ];
    const fits = selectTarget(reading(accounts), {
      strategy: 'work-aware',
      activeNumber: null,
      minHeadroomPct: 0,
      neededHeadroomPct: 25,
      now,
    });
    expect(fits.chosen?.number).toBe(2);

    const doesNot = selectTarget(reading(accounts), {
      strategy: 'work-aware',
      activeNumber: null,
      minHeadroomPct: 0,
      neededHeadroomPct: 95,
      now,
    });
    expect(doesNot.chosen).toBeNull();
    expect(doesNot.reason).toContain('Refusing to rotate');
  });
});

describe('pickTarget', () => {
  it('is the same ranking the switch command uses, not a second one', () => {
    // Two selectors meant the watcher and `rotorcc switch` could disagree about
    // the same reading, and only one of them would ever get fixed.
    const table = reading(
      [
        account(
          1,
          [
            { name: '5h', headroomPct: 5 },
            { name: '7d', headroomPct: 5 },
          ],
          { active: true },
        ),
        account(2, [
          { name: '5h', headroomPct: 100 },
          { name: '7d', headroomPct: 10, resetsInMinutes: 5 * 24 * 60 },
        ]),
        account(3, [
          { name: '5h', headroomPct: 1, resetsInMinutes: 20 },
          { name: '7d', headroomPct: 28, resetsInMinutes: 3 * 24 * 60 },
        ]),
      ],
      1,
    );
    const config = testConfig({ minTargetHeadroomPct: 0 });

    expect(pickTarget(table, config)?.number).toBe(3);
    expect(
      selectTarget(table, {
        strategy: 'best',
        activeNumber: 1,
        minHeadroomPct: 0,
        models: config.models,
      }).chosen?.number,
    ).toBe(3);
  });
});
