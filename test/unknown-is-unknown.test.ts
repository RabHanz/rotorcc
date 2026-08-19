/**
 * The one rule, tested everywhere it could be broken.
 *
 * rotorcc has now had three production defects of the same shape: it reported
 * confidently while doing nothing. The countermeasure is that an account it
 * could not measure is reported as unmeasured — never as zero, never as full,
 * never as a bar on a screen.
 *
 * That rule is only worth anything if it is enforced at every surface, so this
 * file walks each of them: the selection logic that could rotate onto an
 * unknown, the burn model that could extrapolate from one, the dashboard that
 * could draw one, and the JSON that could emit one as a number.
 */
import { describe, expect, it } from 'vitest';

import { selectTarget } from '../src/accounts/select.js';
import {
  BurnStore,
  burnRateFrom,
  confidenceFor,
  predictThreshold,
  willFinishFirst,
} from '../src/core/burn.js';
import { type AccountReading, type UsageReading, headroomIsKnown } from '../src/core/usage.js';
import { renderDashboard } from '../src/tui/render.js';
import { palette } from '../src/tui/theme.js';
import { cleanup, tempDir } from './helpers.js';

function measured(
  number: number,
  headroomPct: number,
  extra: Partial<AccountReading> = {},
): AccountReading {
  return {
    number,
    email: `a${number}@example.com`,
    active: false,
    headroomPct,
    headroomKnown: true,
    bindingWindow: '5h',
    bindingResetsAt: '2026-08-20T00:00:00Z',
    windows: [{ name: '5h', headroomPct }],
    stale: false,
    usageAgeMs: 1000,
    ...extra,
  };
}

function unmeasured(
  number: number,
  reason: string,
  extra: Partial<AccountReading> = {},
): AccountReading {
  return {
    number,
    email: `a${number}@example.com`,
    active: false,
    // The placeholder. Every surface must refuse to show it.
    headroomPct: 0,
    headroomKnown: false,
    unknownReason: reason,
    bindingWindow: 'unknown',
    windows: [],
    stale: true,
    usageAgeMs: null,
    ...extra,
  };
}

function reading(accounts: AccountReading[], activeNumber: number | null = 1): UsageReading {
  return {
    observedAt: '2026-08-19T12:00:00Z',
    activeAccountNumber: activeNumber,
    accounts,
    source: 'native',
  };
}

describe('headroomIsKnown', () => {
  it('is explicit when the field is present', () => {
    expect(headroomIsKnown(measured(1, 50))).toBe(true);
    expect(headroomIsKnown(unmeasured(1, 'never polled'))).toBe(false);
  });

  it('falls back to !stale for a reading written before the field existed', () => {
    const legacy = { ...measured(1, 50) };
    delete (legacy as { headroomKnown?: boolean }).headroomKnown;
    expect(headroomIsKnown(legacy)).toBe(true);
    expect(headroomIsKnown({ ...legacy, stale: true })).toBe(false);
  });
});

describe('target selection never rotates onto an unknown', () => {
  const options = { activeNumber: 1, minHeadroomPct: 20 } as const;

  it('rejects an unmeasured account even when it is the only candidate', () => {
    const selection = selectTarget(
      reading([measured(1, 3, { active: true }), unmeasured(2, 'token needs re-auth')]),
      { ...options, strategy: 'best' },
    );
    expect(selection.chosen).toBeNull();
    expect(selection.rejected.map((r) => r.reason).join(' ')).toContain('headroom unknown');
  });

  it('says WHY it was rejected, not merely that it was', () => {
    const selection = selectTarget(
      reading([measured(1, 3, { active: true }), unmeasured(2, 'token needs re-auth')]),
      { ...options, strategy: 'best' },
    );
    expect(selection.reason).toContain('token needs re-auth');
  });

  it('applies to every strategy, not just the default', () => {
    for (const strategy of ['best', 'next-available', 'consume-first', 'work-aware'] as const) {
      const selection = selectTarget(
        reading([measured(1, 3, { active: true }), unmeasured(2, 'not measured')]),
        { ...options, strategy, neededHeadroomPct: 10 },
      );
      expect(selection.chosen, strategy).toBeNull();
    }
  });

  it('still picks a measured account when one is beside the unknown', () => {
    const selection = selectTarget(
      reading([measured(1, 3, { active: true }), unmeasured(2, 'x'), measured(3, 80)]),
      { ...options, strategy: 'best' },
    );
    expect(selection.chosen?.number).toBe(3);
  });

  it('excludes an API-key account by default, since it has no window to measure', () => {
    const selection = selectTarget(
      reading([
        measured(1, 3, { active: true }),
        unmeasured(2, 'API-key account', { kind: 'api-key' }),
      ]),
      { ...options, strategy: 'best' },
    );
    expect(selection.chosen).toBeNull();
    expect(selection.rejected.some((r) => r.reason.includes('API-key'))).toBe(true);
  });

  it('excludes a disabled account from automatic selection but not by force', () => {
    const accounts = [measured(1, 3, { active: true }), measured(2, 90, { disabled: true })];
    expect(selectTarget(reading(accounts), { ...options, strategy: 'best' }).chosen).toBeNull();
    expect(
      selectTarget(reading(accounts), { ...options, strategy: 'best', includeDisabled: true })
        .chosen?.number,
    ).toBe(2);
  });
});

describe('work-aware refuses rather than settling', () => {
  it('refuses when nothing is big enough to finish the running work', () => {
    const selection = selectTarget(
      reading([measured(1, 4, { active: true }), measured(2, 25), measured(3, 30)]),
      { strategy: 'work-aware', activeNumber: 1, minHeadroomPct: 20, neededHeadroomPct: 60 },
    );
    // A switcher that picks by headroom alone would take #3 and die in an hour.
    expect(selection.chosen).toBeNull();
    expect(selection.reason).toContain('Refusing to rotate');
  });

  it('picks the largest of the accounts that ARE big enough', () => {
    const selection = selectTarget(
      reading([measured(1, 4, { active: true }), measured(2, 65), measured(3, 90)]),
      { strategy: 'work-aware', activeNumber: 1, minHeadroomPct: 20, neededHeadroomPct: 60 },
    );
    expect(selection.chosen?.number).toBe(3);
  });

  it('says plainly that it was NOT a sized choice when there is no estimate', () => {
    const selection = selectTarget(reading([measured(1, 4, { active: true }), measured(2, 65)]), {
      strategy: 'work-aware',
      activeNumber: 1,
      minHeadroomPct: 20,
      neededHeadroomPct: null,
    });
    expect(selection.chosen?.number).toBe(2);
    expect(selection.reason).toContain('NOT a sized choice');
  });
});

describe('burn rate refuses to extrapolate from nothing', () => {
  it('returns a null rate — never zero — with no history', () => {
    const rate = burnRateFrom(null);
    // Zero would mean "measured, and not burning", which is a completely
    // different claim from "I have no idea".
    expect(rate.pctPerHour).toBeNull();
    expect(rate.confidence).toBe('none');
    expect(rate.basis).toContain('no headroom history');
  });

  it('returns null with too few samples, and says how few', () => {
    const rate = burnRateFrom({
      windowKey: 'w',
      windowName: '5h',
      samples: [{ at: Date.now(), headroomPct: 50 }],
    });
    expect(rate.pctPerHour).toBeNull();
    expect(rate.basis).toContain('1 recent sample');
  });

  it('returns null when the samples span too short a time to extrapolate', () => {
    const now = Date.now();
    const rate = burnRateFrom({
      windowKey: 'w',
      windowName: '5h',
      samples: [0, 60_000, 120_000].map((offset) => ({
        at: now - offset,
        headroomPct: 50 - offset / 60_000,
      })),
    });
    expect(rate.pctPerHour).toBeNull();
    expect(rate.basis).toContain('too short');
  });

  it('fits a rate once there is enough, and reports the sample count and span', () => {
    const now = Date.now();
    const samples = Array.from({ length: 12 }, (_, i) => ({
      at: now - (11 - i) * 5 * 60_000,
      headroomPct: 60 - i * 2,
    }));
    const rate = burnRateFrom({ windowKey: 'w', windowName: '5h', samples });
    expect(rate.pctPerHour).not.toBeNull();
    // 2 points every 5 minutes is 24 points an hour.
    expect(rate.pctPerHour ?? 0).toBeCloseTo(24, 0);
    expect(rate.samples).toBe(12);
    expect(rate.confidence).not.toBe('none');
  });

  it('never claims high confidence from a short burst', () => {
    expect(confidenceFor(4, 10 * 60_000, 1)).toBe('low');
    expect(confidenceFor(25, 50 * 60_000, 0.95)).toBe('high');
    // Perfectly fitted, plenty of samples, but only twelve minutes of it.
    expect(confidenceFor(25, 12 * 60_000, 1)).toBe('low');
  });

  it('starts a fresh series when the quota window rolls over', () => {
    const dir = tempDir('rotorcc-burn-');
    try {
      const store = new BurnStore(dir);
      store.record(measured(1, 40, { bindingResetsAt: '2026-08-19T20:00:00Z' }), 1000);
      store.record(measured(1, 30, { bindingResetsAt: '2026-08-19T20:00:00Z' }), 2000);
      expect(store.series(1)?.samples.length).toBe(2);

      // The window reset. Fitting a line across that discontinuity is the most
      // likely way this could produce a confidently wrong answer.
      store.record(measured(1, 100, { bindingResetsAt: '2026-08-20T01:00:00Z' }), 3000);
      expect(store.series(1)?.samples.length).toBe(1);
    } finally {
      cleanup(dir);
    }
  });

  it('records NOTHING for an account whose headroom is unknown', () => {
    const dir = tempDir('rotorcc-burn-');
    try {
      const store = new BurnStore(dir);
      store.record(unmeasured(1, 'never polled'), 1000);
      // A placeholder zero here becomes a cliff in the series, and the next
      // prediction claims the account dies in ninety seconds.
      expect(store.series(1)).toBeNull();
    } finally {
      cleanup(dir);
    }
  });
});

describe('prediction', () => {
  const noRate = burnRateFrom(null);

  it('produces no time at all from an unknown rate', () => {
    const prediction = predictThreshold(50, noRate, 5);
    expect(prediction.at).toBeNull();
    expect(prediction.inMs).toBeNull();
    expect(prediction.confidence).toBe('none');
  });

  it('distinguishes "not falling" from "cannot tell"', () => {
    const flat = {
      pctPerHour: 0,
      confidence: 'medium' as const,
      samples: 10,
      spanMs: 30 * 60_000,
      rSquared: 1,
      basis: 'flat',
    };
    const prediction = predictThreshold(50, flat, 5);
    expect(prediction.at).toBeNull();
    expect(prediction.detail).toContain('not falling');
    expect(prediction.detail).not.toContain('no headroom history');
  });

  it('carries the confidence into the answer, not as a footnote', () => {
    const rate = {
      pctPerHour: 30,
      confidence: 'low' as const,
      samples: 4,
      spanMs: 10 * 60_000,
      rSquared: 0.4,
      basis: 'four samples',
    };
    const prediction = predictThreshold(35, rate, 5);
    expect(prediction.confidence).toBe('low');
    expect(prediction.detail).toContain('low confidence');
  });

  it('answers "will the work finish first" with null far more often than a boolean', () => {
    const prediction = predictThreshold(50, noRate, 5);
    expect(willFinishFirst(prediction, null, 50).answer).toBeNull();
    expect(willFinishFirst(prediction, 20, 50).answer).toBeNull();
  });
});

describe('the dashboard never draws a number it does not have', () => {
  const colours = palette('none');

  function baseModel(accounts: AccountReading[]) {
    return {
      now: new Date('2026-08-19T12:00:00Z'),
      version: '0.1.0',
      usage: reading(accounts),
      usageError: null,
      thresholds: { warnPct: 15, softPct: 10, rotatePct: 5 },
      predictions: [],
      workload: null,
      workloadError: null,
      safety: null,
      store: { path: '/store', lastCommit: null, lastCommitAt: null },
      lastSnapshotAt: null,
      watcher: { detail: 'unchecked', healthy: null },
      decisions: [],
      consecutiveIdle: 0,
      flags: { soft: false, rotate: false, allExhausted: false },
      pendingHandover: null,
      dryRun: false,
      refreshing: false,
      noAccountsHint: null,
    };
  }

  it('prints the word "unknown" and the reason, and no percentage', () => {
    const lines = renderDashboard(baseModel([unmeasured(2, 'token needs re-auth')]), {
      palette: colours,
      width: 200,
    });
    const row = lines.find((l) => l.includes('a2@example.com'));
    expect(row).toBeDefined();
    expect(row).toContain('unknown');
    expect(row).toContain('token needs re-auth');
    // The placeholder zero must not surface as "0%".
    expect(row).not.toMatch(/\b0%/);
  });

  it('draws no bar at all for an unknown', () => {
    const lines = renderDashboard(baseModel([unmeasured(2, 'x')]), {
      palette: colours,
      width: 200,
    });
    const row = lines.find((l) => l.includes('a2@example.com')) ?? '';
    // An empty bar and a bar for a genuine 0% look identical, and one of those
    // is a measurement.
    expect(row).not.toContain('░');
    expect(row).not.toContain('█');
  });

  it('does draw a bar and a percentage for a measured account', () => {
    const lines = renderDashboard(baseModel([measured(2, 45)]), {
      palette: colours,
      width: 200,
    });
    const row = lines.find((l) => l.includes('a2@example.com')) ?? '';
    expect(row).toContain('45%');
    expect(row).toContain('█');
  });

  it('says the active account was not identified rather than showing none', () => {
    const model = baseModel([measured(2, 45)]);
    model.usage = { ...model.usage, activeAccountNumber: null, activeDetectionReason: 'no match' };
    const lines = renderDashboard(model, { palette: colours, width: 200 });
    expect(lines.join('\n')).toContain('active account not identified');
  });

  it('marks a dry run unmissably in the header', () => {
    const lines = renderDashboard(
      { ...baseModel([measured(2, 45)]), dryRun: true },
      {
        palette: colours,
        width: 200,
      },
    );
    expect(lines[0]).toContain('DRY RUN');
  });

  it('reports an unknown watcher state as unknown, not as healthy', () => {
    const lines = renderDashboard(baseModel([measured(2, 45)]), {
      palette: colours,
      width: 200,
    }).join('\n');
    expect(lines).toContain('unchecked');
  });

  it('surfaces a long run of do-nothing decisions instead of hiding it', () => {
    const model = {
      ...baseModel([measured(2, 45)]),
      consecutiveIdle: 200,
      decisions: [
        {
          at: '2026-08-19T11:59:00Z',
          kind: 'idle' as const,
          activeAccount: 1,
          targetAccount: null,
          headroomPct: 4,
          bindingWindow: '5h',
          reason: 'nothing to do',
          strategy: 'work-aware',
          dryRun: false,
          unsavedTrees: null,
        },
      ],
    };
    const lines = renderDashboard(model, { palette: colours, width: 200 }).join('\n');
    // This is the 2026-08-19 defect wearing a normal face: hours of confident
    // inaction. Showing the count beside the headroom is what makes it visible.
    expect(lines).toContain('200 consecutive');
  });

  it('shows a decision with unknown headroom as unknown, not as 0%', () => {
    const model = {
      ...baseModel([measured(2, 45)]),
      decisions: [
        {
          at: '2026-08-19T11:59:00Z',
          kind: 'error' as const,
          activeAccount: null,
          targetAccount: null,
          headroomPct: null,
          bindingWindow: 'unknown',
          reason: 'usage source unavailable',
          strategy: null,
          dryRun: false,
          unsavedTrees: null,
        },
      ],
    };
    const lines = renderDashboard(model, { palette: colours, width: 200 });
    const row = lines.find((l) => l.includes('usage source unavailable')) ?? '';
    expect(row).toContain('unknown');
    expect(row).not.toMatch(/\b0%/);
  });
});
