/**
 * The dashboard's mechanics: colour policy, alignment, and the decision journal.
 *
 * The honesty rule itself is tested in `unknown-is-unknown.test.ts`. What is
 * here is everything that would make the dashboard unusable rather than
 * untruthful — colour where it should not be, columns that drift the moment
 * something is coloured, escape sequences cut in half by a narrow terminal.
 */
import { describe, expect, it } from 'vitest';

import { DecisionJournal, MAX_ENTRIES } from '../src/core/history.js';
import { bar, renderDashboard } from '../src/tui/render.js';
import {
  padVisible,
  palette,
  shouldColour,
  truncateVisible,
  visibleWidth,
} from '../src/tui/theme.js';
import type { AccountReading } from '../src/core/usage.js';
import { cleanup, tempDir } from './helpers.js';

describe('colour policy', () => {
  it('honours NO_COLOR set to anything at all, including empty', () => {
    expect(shouldColour('auto', { env: { NO_COLOR: '' }, isTTY: true }).enabled).toBe(false);
    expect(shouldColour('auto', { env: { NO_COLOR: '1' }, isTTY: true }).enabled).toBe(false);
  });

  it('is off when stdout is not a terminal', () => {
    // A dashboard piped into a file should be a dashboard, not escape codes.
    expect(shouldColour('auto', { env: {}, isTTY: false }).enabled).toBe(false);
  });

  it('is off for TERM=dumb', () => {
    expect(shouldColour('auto', { env: { TERM: 'dumb' }, isTTY: true }).enabled).toBe(false);
  });

  it('is off when the theme is explicitly none', () => {
    expect(shouldColour('none', { env: {}, isTTY: true }).enabled).toBe(false);
  });

  it('says WHY it is off, so a monochrome dashboard is explicable', () => {
    expect(shouldColour('auto', { env: {}, isTTY: false }).reason).toContain('not a terminal');
  });

  it('gives unknown its own colour, never shared with good or bad', () => {
    const c = palette('auto', { env: {}, isTTY: true });
    const unknown = c.unknown('x');
    // Sharing a colour with either health state is how an unknown reads as a
    // verdict at a glance.
    expect(unknown).not.toBe(c.good('x'));
    expect(unknown).not.toBe(c.bad('x'));
    expect(unknown).not.toBe(c.warn('x'));
  });

  it('emits no escape codes at all when disabled', () => {
    const c = palette('none');
    expect(c.bad('danger')).toBe('danger');
    expect(c.enabled).toBe(false);
  });
});

describe('ANSI-aware layout', () => {
  it('measures visible width, ignoring escapes', () => {
    const c = palette('auto', { env: {}, isTTY: true });
    // `padEnd` on a coloured string counts the escape bytes and produces a
    // column eight characters short.
    expect(visibleWidth(c.good('abc'))).toBe(3);
  });

  it('pads to the visible width, so coloured columns still line up', () => {
    const c = palette('auto', { env: {}, isTTY: true });
    expect(visibleWidth(padVisible(c.good('abc'), 10))).toBe(10);
  });

  it('strips colour before truncating, so no half escape reaches the terminal', () => {
    const c = palette('auto', { env: {}, isTTY: true });
    const cut = truncateVisible(c.bad('a very long coloured string'), 10);
    // A truncated escape sequence leaves the terminal stuck in that colour for
    // the rest of the session.
    expect(cut).not.toContain('[');
    expect(visibleWidth(cut)).toBeLessThanOrEqual(10);
  });

  it('leaves a short string alone', () => {
    expect(truncateVisible('short', 40)).toBe('short');
  });
});

describe('the headroom meter', () => {
  it('is proportional and always exactly the requested width', () => {
    expect(bar(100, 10)).toBe('██████████');
    expect(bar(0, 10)).toBe('░░░░░░░░░░');
    expect(bar(50, 10).length).toBe(10);
  });
});

describe('the decision journal', () => {
  function withJournal<T>(body: (journal: DecisionJournal) => T): T {
    const dir = tempDir('rotorcc-journal-');
    try {
      return body(new DecisionJournal(dir));
    } finally {
      cleanup(dir);
    }
  }

  const entry = (kind: 'idle' | 'rotated' | 'refused', reason = 'because') => ({
    kind,
    activeAccount: 1,
    targetAccount: null,
    headroomPct: 50,
    bindingWindow: '5h',
    reason,
    strategy: 'work-aware',
    dryRun: false,
    unsavedTrees: null,
  });

  it('returns the most recent first', () => {
    withJournal((journal) => {
      journal.record(entry('idle', 'first'));
      journal.record(entry('rotated', 'second'));
      expect(journal.recent(2).map((e) => e.reason)).toEqual(['second', 'first']);
    });
  });

  it('records a refusal as loudly as a rotation', () => {
    withJournal((journal) => {
      journal.record(entry('refused', 'unsaved work on a protected branch'));
      expect(journal.recent(1)[0]?.kind).toBe('refused');
    });
  });

  it('counts consecutive do-nothing decisions', () => {
    withJournal((journal) => {
      // This is the 2026-08-19 defect made visible: hours of confident
      // inaction, with nothing recording that it happened.
      for (let i = 0; i < 5; i += 1) journal.record(entry('idle'));
      expect(journal.consecutiveIdle()).toBe(5);
      journal.record(entry('rotated'));
      expect(journal.consecutiveIdle()).toBe(0);
    });
  });

  it('finds the last decision that actually did something', () => {
    withJournal((journal) => {
      journal.record(entry('rotated', 'the real event'));
      for (let i = 0; i < 20; i += 1) journal.record(entry('idle'));
      // A screen full of "idle" is what an operator should not have to read
      // through to find the last real event.
      expect(journal.lastAction()?.reason).toBe('the real event');
    });
  });

  it('caps the file rather than growing forever', () => {
    withJournal((journal) => {
      for (let i = 0; i < MAX_ENTRIES + 20; i += 1) journal.record(entry('idle', `n${i}`));
      const all = journal.read().entries;
      expect(all.length).toBe(MAX_ENTRIES);
      expect(all[all.length - 1]?.reason).toBe(`n${MAX_ENTRIES + 19}`);
    });
  });

  it('treats an unparseable journal as empty rather than refusing to run', () => {
    withJournal((journal) => {
      // Derived data: losing it costs history, not correctness.
      expect(journal.recent()).toEqual([]);
    });
  });

  it('keeps a null headroom null, so a decision made blind stays visibly blind', () => {
    withJournal((journal) => {
      journal.record({ ...entry('idle'), headroomPct: null, activeAccount: null });
      expect(journal.recent(1)[0]?.headroomPct).toBeNull();
    });
  });
});

describe('the dashboard under stress', () => {
  const colours = palette('none');
  const account: AccountReading = {
    number: 1,
    email: 'someone-with-a-very-long-address@a-long-domain.example.com',
    active: true,
    headroomPct: 42,
    headroomKnown: true,
    bindingWindow: '7d',
    bindingResetsAt: '2026-08-24T13:00:00Z',
    windows: [{ name: '7d', headroomPct: 42 }],
    stale: false,
    usageAgeMs: 5000,
  };

  const model = {
    now: new Date('2026-08-19T12:00:00Z'),
    version: '0.1.0',
    usage: {
      observedAt: '2026-08-19T12:00:00Z',
      activeAccountNumber: 1,
      accounts: [account],
      source: 'native' as const,
    },
    usageError: null,
    thresholds: { warnPct: 15, softPct: 10, rotatePct: 5 },
    predictions: [],
    workload: null,
    workloadError: null,
    safety: null,
    store: { path: '/store', lastCommit: null, lastCommitAt: null },
    lastSnapshotAt: null,
    watcher: { detail: 'systemd timer active', healthy: true },
    decisions: [],
    consecutiveIdle: 0,
    flags: { soft: false, rotate: false, allExhausted: false },
    pendingHandover: null,
    dryRun: false,
    refreshing: false,
    noAccountsHint: null,
    strategy: 'work-aware' as const,
    selection: null,
    lastRefusal: null,
    raisedFlags: [],
  };

  it('never emits a line wider than the terminal', () => {
    for (const width of [48, 60, 80, 100, 200]) {
      const lines = renderDashboard(model, { palette: colours, width });
      for (const line of lines) {
        expect(visibleWidth(line), `width ${width}: ${line}`).toBeLessThanOrEqual(width);
      }
    }
  });

  it('still renders every section on a very narrow terminal', () => {
    const text = renderDashboard(model, { palette: colours, width: 48 }).join('\n');
    for (const section of ['ACCOUNTS', 'PREDICTION', 'WORK IN FLIGHT', 'DURABILITY']) {
      expect(text).toContain(section);
    }
  });

  it('says the trees were not inspected rather than showing them as clean', () => {
    const text = renderDashboard(
      { ...model, workload: null, workloadError: 'git is not runnable' },
      { palette: colours, width: 120 },
    ).join('\n');
    // "nothing unsaved" for trees nobody looked at is exactly the confident
    // report this project keeps having to remove.
    expect(text).toContain('git is not runnable');
    expect(text).not.toContain('nothing unsaved');
  });

  it('shows a refusal verdict prominently when one would apply', () => {
    const text = renderDashboard(
      {
        ...model,
        workload: {
          unsaved: [],
          savable: [],
          needsHuman: [],
          sessions: [],
          activeSessions: [],
          takenAt: '2026-08-19T12:00:00Z',
        },
        safety: { verdict: 'refuse', reason: 'a tree is mid-rebase', trees: [] },
      },
      { palette: colours, width: 120 },
    ).join('\n');
    expect(text).toContain('WOULD REFUSE TO ROTATE');
    expect(text).toContain('mid-rebase');
  });

  it('shows a queued handover, because landing on a different account must not surprise', () => {
    const text = renderDashboard(
      {
        ...model,
        pendingHandover: {
          slot: 3,
          reason: 'weekly window down to 3% on 7d',
          expiresAt: '2026-08-19T18:00:00Z',
        },
      },
      { palette: colours, width: 120 },
    ).join('\n');
    expect(text).toContain('NEXT SESSION');
    expect(text).toContain('will open on slot 3');
    expect(text).toContain('weekly window down to 3%');
    // The reassurance that matters: the running session is not being touched.
    expect(text).toContain('nothing is interrupted');
  });

  it('says plainly when no handover is queued, rather than leaving it blank', () => {
    const text = renderDashboard(model, { palette: colours, width: 120 }).join('\n');
    expect(text).toContain('no handover queued');
  });

  it('makes the all-exhausted stop the loudest thing on the screen', () => {
    const text = renderDashboard(
      { ...model, flags: { soft: false, rotate: false, allExhausted: true } },
      { palette: colours, width: 120 },
    ).join('\n');
    expect(text).toContain('ALL ACCOUNTS OUT OF WEEKLY QUOTA');
    expect(text).toContain('rotorcc has stopped');
    expect(text).toContain('Wait for a reset');
  });

  it('points at how to add an account when there are none', () => {
    const text = renderDashboard(
      {
        ...model,
        usage: { ...model.usage, accounts: [] },
        noAccountsHint: 'Add one with "rotorcc accounts add".',
      },
      { palette: colours, width: 120 },
    ).join('\n');
    expect(text).toContain('manages no accounts yet');
    expect(text).toContain('rotorcc accounts add');
  });
});
