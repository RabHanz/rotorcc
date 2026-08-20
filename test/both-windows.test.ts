/**
 * Both windows, always, labelled, on every surface.
 *
 * The incident this file is the fix for: rotorcc reported an account as nearly
 * dead. Its 5-hour window was 99% spent and its week was 72% spent. Those two
 * numbers describe completely different situations — "wait forty minutes" and
 * "this account is finished until Sunday" — and the display collapsed them into
 * one because it printed only the window that happened to bind.
 *
 * So the rule is not "show more information". It is: **the operator must never
 * be in a position where they have to infer the other window.** Every account
 * row on every surface carries its 5h and its 7d, each labelled, each as spend.
 * Which window binds is still marked, because that is real information; it just
 * cannot be the only thing on screen.
 *
 * The second half of the file is the same rule turned around: an inversion is
 * the easiest place in the world to turn an unknown into a confident number.
 * Under the old headroom convention `?? 0` read as "spent", which was
 * conservative. Under "used" the identical fallback reads as "completely
 * fresh", which would make the one account rotorcc could not measure the most
 * attractive rotation target on the screen. There is therefore no fallback
 * anywhere: a window that was not measured prints `unknown` and is `null`.
 */
import { describe, expect, it } from 'vitest';

import { listAccounts } from '../src/commands/accounts.js';
import { renderStatus, statusJson } from '../src/commands/status.js';
import type { StatusReport } from '../src/commands/status.js';
import { renderManifestMarkdown, parseManifest } from '../src/core/manifest.js';
import { evaluatePolicy, renderStopNotice } from '../src/core/policy.js';
import { renderDashboard } from '../src/tui/render.js';
import type { DashboardModel } from '../src/tui/render.js';
import { palette } from '../src/tui/theme.js';
import {
  type AccountReading,
  accountHeadline,
  accountJson,
  formatWindowsUsed,
  windowsUsedOf,
} from '../src/core/usage.js';
import { testConfig } from './helpers.js';

/**
 * The account from the incident: its rate limit is all but gone and its week is
 * fine. Every assertion below that uses it is asking the same question — can a
 * reader tell those two facts apart?
 */
function incidentAccount(overrides: Partial<AccountReading> = {}): AccountReading {
  return {
    number: 1,
    alias: 'primary',
    email: 'primary@example.com',
    active: true,
    // The binding window is the 5-hour one, at 1% headroom.
    headroomPct: 1,
    headroomKnown: true,
    bindingWindow: '5h',
    bindingResetsAt: '2026-08-20T04:00:00Z',
    windows: [
      { name: '5h', headroomPct: 1, resetsAt: '2026-08-20T04:00:00Z' },
      { name: '7d', headroomPct: 28, resetsAt: '2026-08-25T11:00:00Z' },
    ],
    stale: false,
    usageAgeMs: 1_000,
    ...overrides,
  };
}

function unmeasured(number = 2, reason = 'quota read failed: http-429'): AccountReading {
  return {
    number,
    email: `spare${number}@example.com`,
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
      observedAt: '2026-08-20T01:00:00Z',
      activeAccountNumber: 1,
      accounts,
      source: 'native',
    },
    usageError: null,
    level: 'rotate',
    store: { path: '/store', exists: false, lastCommit: null, lastCommitAt: null },
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

function dashboard(accounts: AccountReading[]): DashboardModel {
  return {
    now: new Date('2026-08-20T01:00:00Z'),
    version: '0.2.0',
    usage: {
      observedAt: '2026-08-20T01:00:00Z',
      activeAccountNumber: 1,
      accounts,
      source: 'native',
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
    strategy: 'work-aware',
    selection: null,
    lastRefusal: null,
    raisedFlags: [],
  };
}

/**
 * Every percentage on a line must be accompanied by a window name.
 *
 * The scan is deliberately dumb: it is checking the property the incident
 * violated, which is that a figure appeared with nothing to say what it was a
 * figure OF. Threshold lines are exempt because they state a rule rather than a
 * measurement, and they name the rule they belong to.
 */
function everyPercentageNamesAWindow(text: string): void {
  for (const line of text.split('\n')) {
    if (!/\d+%/.test(line)) continue;
    if (/thresholds?|warn at|soft at|rotate at|floor|dirty/.test(line)) continue;
    expect(line, `no window named on: ${line}`).toMatch(/\b(5h|7d|opus-7d|Fable|week|hour)\b/);
  }
}

describe('windowsUsedOf', () => {
  it('always yields 5h and 7d, in that order, whatever the account reported', () => {
    const only7d = incidentAccount({
      windows: [{ name: '7d', headroomPct: 28 }],
      bindingWindow: '7d',
      headroomPct: 28,
    });
    expect(windowsUsedOf(only7d).map((w) => w.name)).toEqual(['5h', '7d']);
    expect(windowsUsedOf(incidentAccount()).map((w) => w.name)).toEqual(['5h', '7d']);
  });

  it('appends a per-model weekly cap rather than dropping it', () => {
    const capped = incidentAccount({
      windows: [
        { name: '5h', headroomPct: 1 },
        { name: '7d', headroomPct: 28 },
        { name: 'opus-7d', headroomPct: 4 },
      ],
    });
    // A full per-model cap stops the work exactly as hard as the account-wide
    // window. Ranked last, never dropped.
    expect(windowsUsedOf(capped).map((w) => w.name)).toEqual(['5h', '7d', 'opus-7d']);
  });

  it('reports spend, not headroom', () => {
    const rows = windowsUsedOf(incidentAccount());
    expect(rows[0]).toMatchObject({ name: '5h', usedPct: 99, headroomPct: 1 });
    expect(rows[1]).toMatchObject({ name: '7d', usedPct: 72, headroomPct: 28 });
  });

  it('marks exactly the window that binds', () => {
    const rows = windowsUsedOf(incidentAccount());
    expect(rows.filter((w) => w.binding).map((w) => w.name)).toEqual(['5h']);
  });

  it('is null with a reason for a window the account never reported', () => {
    const only5h = incidentAccount({ windows: [{ name: '5h', headroomPct: 1 }] });
    const weekly = windowsUsedOf(only5h)[1];
    expect(weekly?.usedPct).toBeNull();
    expect(weekly?.headroomPct).toBeNull();
    expect(weekly?.unknownReason).toContain('7d');
  });

  it('is null on BOTH windows for an unmeasured account, never 0 and never 100', () => {
    const rows = windowsUsedOf(unmeasured());
    expect(rows.map((w) => w.usedPct)).toEqual([null, null]);
    // 100 - 0 is 100, and "100% used" is the most confident possible way to say
    // "we have no idea". 0 is worse still under a used convention: it reads as
    // a completely fresh account.
    expect(rows.every((w) => w.usedPct !== 0 && w.usedPct !== 100)).toBe(true);
    expect(rows[0]?.unknownReason).toBe('quota read failed: http-429');
    // And nothing binds, because the binding window is precisely the fact that
    // could not be established.
    expect(rows.some((w) => w.binding)).toBe(false);
  });
});

describe('the shared one-liners', () => {
  it('formatWindowsUsed names both windows and reports both as used', () => {
    expect(formatWindowsUsed(incidentAccount())).toBe('5h 99% used · 7d 72% used');
  });

  it('accountHeadline adds which window binds without replacing the other figure', () => {
    const headline = accountHeadline(incidentAccount());
    expect(headline).toContain('5h 99% used');
    expect(headline).toContain('7d 72% used');
    expect(headline).toContain('5h binds');
  });

  it('says the binding window is unknown rather than inventing one', () => {
    const headline = accountHeadline(unmeasured());
    expect(headline).toContain('5h unknown');
    expect(headline).toContain('7d unknown');
    expect(headline).toContain('binding window unknown');
    expect(headline).not.toMatch(/\d+%/);
  });
});

describe('rotorcc status', () => {
  it('shows both windows for every account, each labelled, each as spend', () => {
    const text = renderStatus(report([incidentAccount()]), testConfig());
    expect(text).toContain('5h');
    expect(text).toContain('7d');
    expect(text).toContain('99% used');
    expect(text).toContain('72% used');
    // The whole point: the two are on screen together, so "the rate limit is
    // gone" cannot be read as "the week is gone".
    expect(text).toContain('5h binds');
  });

  it('never prints a percentage without saying which window it belongs to', () => {
    everyPercentageNamesAWindow(renderStatus(report([incidentAccount()]), testConfig()));
  });

  it('shows both windows as unknown, with the reason, for an account it could not read', () => {
    const text = renderStatus(report([unmeasured()]), testConfig());
    expect(text).toContain('quota read failed: http-429');
    expect(text.match(/unknown/g)?.length).toBeGreaterThanOrEqual(2);
    expect(text).not.toContain('0% used');
    expect(text).not.toContain('100% used');
  });
});

describe('status --json', () => {
  it('carries both windows per account, as used and as headroom', () => {
    const json = statusJson(report([incidentAccount()])) as {
      usage: { accounts: Array<ReturnType<typeof accountJson>> };
    };
    const account = json.usage.accounts[0];
    expect(account?.windows.map((w) => w.name)).toEqual(['5h', '7d']);
    expect(account?.windows[0]).toMatchObject({ name: '5h', usedPct: 99, binding: true });
    expect(account?.windows[1]).toMatchObject({ name: '7d', usedPct: 72, binding: false });
  });

  it('nulls what was never measured instead of serialising the placeholder zero', () => {
    const json = statusJson(report([unmeasured()])) as {
      usage: { accounts: Array<ReturnType<typeof accountJson>> };
    };
    const account = json.usage.accounts[0];
    // `AccountReading.headroomPct` is a placeholder 0 inside the decision code,
    // which always asks `headroomIsKnown` first. Serialised for somebody else to
    // read it is a measurement that never happened.
    expect(account?.headroomPct).toBeNull();
    expect(account?.usedPct).toBeNull();
    expect(account?.bindingWindow).toBeNull();
    expect(account?.unknownReason).toBe('quota read failed: http-429');
    expect(account?.windows.every((w) => w.usedPct === null)).toBe(true);
  });
});

describe('rotorcc accounts', () => {
  async function render(accounts: AccountReading[], json = false): Promise<string> {
    const lines: string[] = [];
    await listAccounts({
      config: testConfig(),
      manager: {
        readUsage: async () => ({
          observedAt: '2026-08-20T01:00:00Z',
          activeAccountNumber: 1,
          accounts,
          source: 'native' as const,
        }),
      } as never,
      dryRun: false,
      json,
      yes: false,
      out: (line) => lines.push(line),
    });
    return lines.join('\n');
  }

  it('lists both windows for every account', async () => {
    const text = await render([incidentAccount()]);
    expect(text).toContain('99% used');
    expect(text).toContain('72% used');
    expect(text).toContain('5h binds');
  });

  it('emits both windows in --json, with nulls for what it could not read', async () => {
    const parsed = JSON.parse(await render([incidentAccount(), unmeasured()], true)) as {
      accounts: Array<ReturnType<typeof accountJson>>;
    };
    expect(parsed.accounts[0]?.windows.map((w) => w.usedPct)).toEqual([99, 72]);
    expect(parsed.accounts[1]?.windows.map((w) => w.usedPct)).toEqual([null, null]);
  });
});

describe('the dashboard', () => {
  const colours = palette('none');

  it('shows both windows on the account row', () => {
    const text = renderDashboard(dashboard([incidentAccount()]), {
      palette: colours,
      width: 200,
    }).join('\n');
    expect(text).toContain('99% used');
    expect(text).toContain('72% used');
    expect(text).toContain('5h binds');
  });

  it('keeps both figures when the terminal is too narrow for the bars', () => {
    // Given a choice between a picture of one number and both numbers, both
    // numbers win — the defect this layout exists to prevent was caused by
    // seeing one window and inferring the other.
    const line =
      renderDashboard(dashboard([incidentAccount()]), { palette: colours, width: 84 }).find((l) =>
        l.includes('primary'),
      ) ?? '';
    expect(line).toContain('5h');
    expect(line).toContain('99% used');
    expect(line).toContain('7d');
    expect(line).toContain('72% used');
    expect(line).not.toContain('█');
  });

  it('marks the binding window inline, so truncation cannot hide which one it is', () => {
    const line =
      renderDashboard(dashboard([incidentAccount()]), { palette: colours, width: 84 }).find((l) =>
        l.includes('primary'),
      ) ?? '';
    // `*5h` — the mark sits on the window it belongs to rather than in a
    // trailer that a narrow terminal cuts off.
    expect(line).toMatch(/\*5h/);
  });

  it('gives a per-model cap its own line, with a gap before its figure', () => {
    // `Fable13% used`, seen on a real machine: the name column was a fixed
    // three characters, so a longer window name ate the separator and the
    // figure ran straight into it.
    const capped = incidentAccount({
      windows: [
        { name: '5h', headroomPct: 1 },
        { name: '7d', headroomPct: 28 },
        { name: 'opus-7d', headroomPct: 87 },
      ],
    });
    for (const width of [84, 200]) {
      const line =
        renderDashboard(dashboard([capped]), { palette: colours, width }).find((l) =>
          l.includes('opus-7d'),
        ) ?? '';
      expect(line, `width ${width}`).toMatch(/opus-7d\s/);
      expect(line, `width ${width}`).not.toMatch(/opus-7d\d/);
      expect(line, `width ${width}`).toContain('13% used');
    }
  });

  it('reports a past decision as spend with its window, not as bare headroom', () => {
    // A journal line reading `67%` beside an accounts panel reading `33% used`
    // is the same account in two conventions on one screen.
    const model = dashboard([incidentAccount()]);
    const text = renderDashboard(
      {
        ...model,
        decisions: [
          {
            at: '2026-08-20T01:44:00Z',
            kind: 'idle' as const,
            activeAccount: 1,
            targetAccount: null,
            headroomPct: 67,
            bindingWindow: '5h',
            reason: 'nothing to do',
            strategy: 'work-aware',
            dryRun: false,
            unsavedTrees: null,
          },
        ],
      },
      { palette: colours, width: 200 },
    ).join('\n');
    expect(text).toContain('33% used (5h)');
    expect(text).not.toMatch(/idle\s+67%/);
  });

  it('draws no cursor and no panel when there is no keyboard', () => {
    // `--once`, and anything piped, render a read-only frame. A frame going
    // into a cron mail has no cursor, and must not look like a control surface.
    const lines = renderDashboard(dashboard([incidentAccount()]), {
      palette: colours,
      width: 200,
    });
    expect(lines.join('\n')).not.toContain('❯');
    // And the whole standing report is still there, rather than being replaced
    // by a panel that nobody can dismiss.
    for (const section of ['ACCOUNTS', 'PREDICTION', 'WORK IN FLIGHT', 'DURABILITY']) {
      expect(lines.join('\n')).toContain(section);
    }
  });

  it('draws no bar and no number for either window of an unmeasured account', () => {
    const line =
      renderDashboard(dashboard([unmeasured()]), { palette: colours, width: 200 }).find((l) =>
        l.includes('spare2@example.com'),
      ) ?? '';
    expect(line).not.toContain('█');
    expect(line).not.toContain('░');
    expect(line).not.toMatch(/\d+%/);
    expect(line).toContain('unknown');
  });
});

describe('the resume manifest', () => {
  const manifest = parseManifest({
    schemaVersion: 1,
    id: 'manifest-1',
    createdAt: '2026-08-20T01:00:00Z',
    trigger: 'rotate',
    tool: { name: 'rotorcc', version: '0.2.0' },
    session: null,
    accounts: {
      activeNumber: 1,
      targetNumber: null,
      observedAt: '2026-08-20T01:00:00Z',
      list: [
        {
          number: 1,
          label: 'primary',
          headroomPct: 1,
          usedPct: 99,
          bindingWindow: '5h',
          resetsAt: '2026-08-20T04:00:00Z',
          active: true,
          windows: [
            { name: '5h', usedPct: 99, resetsAt: '2026-08-20T04:00:00Z', binding: true },
            { name: '7d', usedPct: 72, resetsAt: '2026-08-25T11:00:00Z', binding: false },
          ],
        },
        {
          number: 2,
          label: 'spare',
          headroomPct: null,
          usedPct: null,
          bindingWindow: 'unknown',
          resetsAt: null,
          active: false,
          windows: [
            { name: '5h', usedPct: null, resetsAt: null, binding: false },
            { name: '7d', usedPct: null, resetsAt: null, binding: false },
          ],
        },
      ],
    },
    projects: [],
    snapshot: {
      storePath: '/store',
      commit: null,
      filesCopied: 0,
      bytesCopied: 0,
      mirror: { attempted: false, ok: false, detail: 'off' },
      secretHits: 0,
    },
    cleanExit: true,
  });

  it('gives each window its own column, so the table can be read months later', () => {
    const markdown = renderManifestMarkdown(manifest);
    expect(markdown).toContain('| 5h used | 7d used |');
    expect(markdown).toContain('| 99% | 72% |');
  });

  it('records an unmeasured account as unknown rather than as empty', () => {
    const markdown = renderManifestMarkdown(manifest);
    expect(markdown).toContain('| unknown | unknown |');
    expect(markdown).not.toContain('| 0% | 0% |');
  });

  it('still parses a manifest written before windows were recorded', () => {
    // Old manifests carried one headroom figure and no window list. They must
    // keep opening: a rescue document that will not load is worse than a
    // rescue document that is less detailed than a new one.
    const old = parseManifest({
      ...JSON.parse(JSON.stringify(manifest)),
      accounts: {
        activeNumber: 1,
        targetNumber: null,
        observedAt: '2026-08-20T01:00:00Z',
        list: [
          {
            number: 1,
            label: 'primary',
            headroomPct: 4,
            bindingWindow: '5h',
            resetsAt: null,
            active: true,
          },
        ],
      },
    });
    expect(old.accounts.list[0]?.windows).toEqual([]);
    expect(old.accounts.list[0]?.headroomPct).toBe(4);
    expect(renderManifestMarkdown(old)).toContain('| unknown | unknown |');
  });
});

describe('the decision reason a tick records', () => {
  it('names both windows and which one binds', async () => {
    const { decide } = await import('../src/core/decide.js');
    const { emptyState } = await import('../src/core/decide.js');
    const decision = decide(
      {
        observedAt: '2026-08-20T01:00:00Z',
        activeAccountNumber: 1,
        accounts: [incidentAccount({ headroomPct: 60, bindingWindow: '7d' })],
        source: 'native',
      },
      testConfig(),
      emptyState(),
    );
    // This reason is what lands in the decision journal, the tick's `--json`
    // output and the log. Read six hours later, "headroom 67% on 5h" cannot
    // tell you whether the week was also nearly gone.
    expect(decision.reason).toContain('5h 99% used');
    expect(decision.reason).toContain('7d 72% used');
    expect(decision.reason).toContain('binds');
  });
});

describe('the all-accounts-exhausted notice', () => {
  it('says how each account is exhausted, not just that it is', () => {
    const stop = evaluatePolicy({
      reading: {
        observedAt: '2026-08-20T01:00:00Z',
        activeAccountNumber: 1,
        accounts: [
          incidentAccount({
            headroomPct: 2,
            bindingWindow: '7d',
            windows: [
              { name: '5h', headroomPct: 90, resetsAt: '2026-08-20T04:00:00Z' },
              { name: '7d', headroomPct: 2, resetsAt: '2026-08-25T11:00:00Z' },
            ],
          }),
          {
            ...incidentAccount({ number: 2, alias: 'other', active: false }),
            headroomPct: 1,
            bindingWindow: '7d',
            windows: [
              { name: '5h', headroomPct: 4, resetsAt: '2026-08-20T04:00:00Z' },
              { name: '7d', headroomPct: 1, resetsAt: '2026-08-25T11:00:00Z' },
            ],
          },
        ],
        source: 'native',
      },
      config: testConfig(),
      sessionAlive: true,
    });

    expect(stop.kind).toBe('stop');
    if (stop.kind !== 'stop') return;
    const notice = renderStopNotice(stop);
    // One account is out of week with its rate limit almost untouched; the
    // other is out of both. The human this notice is addressed to needs to be
    // able to tell those apart, and one figure per account cannot.
    expect(notice).toContain('5h 10% used');
    expect(notice).toContain('7d 98% used');
    expect(notice).toContain('5h 96% used');
    expect(notice).toContain('7d 99% used');
    expect(notice).not.toContain('% left');
  });
});
