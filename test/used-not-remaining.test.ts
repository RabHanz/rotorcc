/**
 * The display convention: rotorcc reports what has been SPENT, with the window
 * named, on every surface.
 *
 * Two errors in one day came from the old convention. Anthropic's API reports
 * utilisation and Claude Code's status line reports utilisation, so rotorcc
 * reporting headroom made an operator invert one screen in their head at the
 * moment they were trying to decide something quickly — and a bare percentage
 * whose window had to be inferred made "1%" ambiguous between a five-hour
 * window that returns within the hour and a week that does not.
 *
 * The inversion is also the easiest possible place to turn an unknown into a
 * confident number, so half of this file is about that not happening.
 */
import { describe, expect, it } from 'vitest';

import { renderStatus } from '../src/commands/status.js';
import type { StatusReport } from '../src/commands/status.js';
import { formatUsed, usedPctOf } from '../src/core/usage.js';
import type { AccountReading } from '../src/core/usage.js';
import { testConfig } from './helpers.js';

function measured(number: number, headroomPct: number, window = '5h'): AccountReading {
  return {
    number,
    email: `a${number}@example.com`,
    active: number === 1,
    headroomPct,
    headroomKnown: true,
    bindingWindow: window,
    bindingResetsAt: '2026-08-20T04:00:00Z',
    windows: [{ name: window, headroomPct }],
    stale: false,
    usageAgeMs: 1000,
  };
}

function unmeasured(number: number, reason: string): AccountReading {
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

function report(accounts: AccountReading[]): StatusReport {
  return {
    usage: {
      observedAt: '2026-08-19T23:00:00Z',
      activeAccountNumber: 1,
      accounts,
      source: 'native',
    },
    usageError: null,
    level: 'ok',
    store: { path: '/tmp/store', exists: false, lastCommit: null, lastCommitAt: null },
    lastSnapshotAt: null,
    lastManifest: null,
    flags: { soft: false, rotate: false, allExhausted: false },
    pendingHandover: null,
    lanes: [],
    unsavedTrees: 0,
    scheduler: { detail: 'none' },
    sessions: [],
  };
}

describe('usedPctOf', () => {
  it('is the complement of headroom for a measured account', () => {
    expect(usedPctOf(measured(1, 45))).toBe(55);
    expect(usedPctOf(measured(1, 0))).toBe(100);
    expect(usedPctOf(measured(1, 100))).toBe(0);
  });

  it('is null for an unmeasured account, not 100', () => {
    // The whole risk of an inversion in one line: 100 - 0 is 100, and "100%
    // used" is the most confident possible way to say "we have no idea".
    expect(usedPctOf(unmeasured(2, 'quota read failed: http-429'))).toBeNull();
  });
});

describe('formatUsed', () => {
  it('always names the window, because a bare percentage is ambiguous', () => {
    expect(formatUsed(measured(1, 1, '5h'))).toBe('99% used (5h)');
    expect(formatUsed(measured(1, 1, '7d'))).toBe('99% used (7d)');
    // Same number, different situations: one returns within the hour and one
    // does not. Printing "99%" alone is what made that indistinguishable.
    expect(formatUsed(measured(1, 1, '5h'))).not.toBe(formatUsed(measured(1, 1, '7d')));
  });

  it('says unknown with the reason, and no number at all', () => {
    const text = formatUsed(unmeasured(2, 'quota read failed: http-429'));
    expect(text).toBe('unknown (quota read failed: http-429)');
    expect(text).not.toMatch(/\d+%/);
  });
});

describe('rotorcc status', () => {
  it('reports used, with the window, and a bar that fills as it is spent', () => {
    const text = renderStatus(report([measured(1, 20)]), testConfig());
    expect(text).toContain('80% used');
    expect(text).toContain('5h');
    expect(text).not.toContain('% left');
    // 80% used is a mostly-full bar.
    expect(text).toMatch(/#{7,}\.{0,3}/);
  });

  it('draws no bar and no number for an account it could not measure', () => {
    const text = renderStatus(report([unmeasured(2, 'quota read failed: http-429')]), testConfig());
    expect(text).toContain('quota read failed: http-429');
    expect(text).toContain('unknown');
    // This line used to print the placeholder zero as "0% left" — the project's
    // own cardinal rule, broken on its most-read screen. Under the used
    // convention the same fallback would read as "0% used", i.e. completely
    // fresh, so neither number may appear.
    expect(text).not.toContain('0% left');
    expect(text).not.toContain('0% used');
    expect(text).not.toContain('100% used');
    expect(text).not.toContain('#####');
  });

  it('states the thresholds in the same direction as the numbers beside them', () => {
    const text = renderStatus(report([measured(1, 50)]), testConfig());
    // Defaults are 15/10/5 headroom, i.e. 85/90/95 used.
    expect(text).toContain('warn at 85% used');
    expect(text).toContain('soft at 90%');
    expect(text).toContain('rotate at 95%');
  });
});
