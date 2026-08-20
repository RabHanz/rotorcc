/**
 * The dashboard, as a pure function.
 *
 * `renderDashboard(model, options) -> string[]`. No I/O, no clock, no
 * subprocess: everything it needs is in the model. That is what makes it
 * testable, and a dashboard whose "unknown renders as unknown" rule is only
 * enforced by eyeballing it in a terminal is a rule that will be broken within
 * a month.
 *
 * The layout answers, in the order a worried operator asks:
 *
 *   1. Which account am I on and how much is left — with the WINDOW that binds
 *      and when it resets, because "12% left" means nothing without knowing
 *      whether that is the 5-hour or the weekly one.
 *   2. When does that run out, and will the running work finish first.
 *   3. What is unsaved right now.
 *   4. Is the machinery that is supposed to protect me actually running.
 *   5. What has it been deciding, and why.
 *
 * The one rule that overrides layout, alignment and everything else:
 * **an unknown number is printed as the word `unknown`, with the reason beside
 * it.** Never a zero, never a full bar, never a dash that could be read as
 * either. There is no branch in this file that formats an unmeasured value as a
 * percentage.
 */
import { type BurnRate, type Prediction, formatDuration } from '../core/burn.js';
import type { DecisionEntry } from '../core/history.js';
import type { Selection } from '../accounts/select.js';
import type { Strategy } from '../accounts/select.js';
import {
  type AccountReading,
  type UsageReading,
  type WindowUsed,
  formatBinding,
  headroomIsKnown,
  windowsUsedOf,
} from '../core/usage.js';
import type { RotationSafety, WorkloadSnapshot } from '../core/workload.js';
import { STRATEGY_CHOICES, type UiState } from './interaction.js';
import { type Palette, padVisible, truncateVisible, visibleWidth } from './theme.js';

export interface AccountPrediction {
  accountNumber: number;
  rate: BurnRate;
  prediction: Prediction;
  /** Whether the running work is expected to finish first. Null = cannot say. */
  finishesFirst: { answer: boolean | null; detail: string };
}

export interface DashboardModel {
  now: Date;
  version: string;
  /** Null when the read failed outright; `usageError` then says why. */
  usage: UsageReading | null;
  usageError: string | null;
  thresholds: { warnPct: number; softPct: number; rotatePct: number };
  predictions: AccountPrediction[];
  workload: WorkloadSnapshot | null;
  workloadError: string | null;
  safety: RotationSafety | null;
  store: { path: string; lastCommit: string | null; lastCommitAt: string | null };
  lastSnapshotAt: string | null;
  watcher: { detail: string; healthy: boolean | null };
  decisions: DecisionEntry[];
  consecutiveIdle: number;
  flags: { soft: boolean; rotate: boolean; allExhausted: boolean };
  /**
   * The account the NEXT session will open on, when one is queued.
   *
   * Shown because it is the single most surprising thing rotorcc can do — an
   * operator who starts a session and lands on a different account must be able
   * to have seen that coming.
   */
  pendingHandover: { slot: number; reason: string; expiresAt: string } | null;
  /** True when this rotorcc is configured to never actually act. */
  dryRun: boolean;
  /** True when a refresh is in flight, so the header can say so. */
  refreshing: boolean;
  /** Set when the account store is empty and nothing can be measured. */
  noAccountsHint: string | null;
  /** The strategy in force, which the `t` key can change. */
  strategy: Strategy;
  /**
   * What the selector would choose right now, and why it rejected each of the
   * others.
   *
   * This is the answer to "why has nothing happened?", computed from the same
   * `selectTarget` the watcher uses rather than reconstructed from prose. Null
   * when there is no reading to select over.
   */
  selection: Selection | null;
  /** The most recent decision that was a refusal, a block or an error. */
  lastRefusal: DecisionEntry | null;
  /** Raised flags with the reason each was raised for. */
  raisedFlags: Array<{ name: string; reason: string; raisedAt: string }>;
}

export interface RenderOptions {
  palette: Palette;
  width: number;
  height?: number;
  /**
   * Keyboard state. Absent for `--once` and for a piped run, which are
   * read-only by nature — a frame going into a file has no cursor.
   */
  ui?: UiState;
}

/** How an unknown is spelled, everywhere, without exception. */
const UNKNOWN = 'unknown';

export function renderDashboard(model: DashboardModel, options: RenderOptions): string[] {
  const { palette: c } = options;
  const width = Math.max(48, options.width);
  const lines: string[] = [];
  const push = (line = ''): void => {
    lines.push(truncateVisible(line, width));
  };

  // ---------------------------------------------------------------- header
  const stamp = model.now.toISOString().slice(11, 19);
  const left = `${c.bold('rotorcc')} ${c.dim(model.version)}`;
  const flags: string[] = [];
  if (model.dryRun) {
    // Unmissable. A dry run that looks like a live run produced a manifest full
    // of "would commit 345 files" that was later read as a rescue record.
    flags.push(c.bad('[DRY RUN — nothing will be written]'));
  }
  if (model.refreshing) flags.push(c.dim('refreshing…'));
  const ui = options.ui;
  if (ui?.busy != null) flags.push(c.accent(`working: ${ui.busy}`));
  if (ui?.paused === true) flags.push(c.warn('PAUSED'));
  const right = `${flags.join(' ')} ${c.dim(stamp)}`.trim();
  push(
    `${left}${' '.repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(right)))}${right}`,
  );
  push();

  // -------------------------------------------------------------- accounts
  push(`${c.bold('ACCOUNTS')} ${c.dim('— how much of each window has been SPENT')}`);
  if (model.usage === null) {
    push(`  ${c.bad('could not read any account')} — ${model.usageError ?? 'reason not recorded'}`);
    if (model.noAccountsHint !== null) push(`  ${c.dim(model.noAccountsHint)}`);
  } else if (model.usage.accounts.length === 0) {
    push(`  ${c.warn('rotorcc manages no accounts yet')}`);
    if (model.noAccountsHint !== null) push(`  ${c.dim(model.noAccountsHint)}`);
  } else {
    const cursor = ui === undefined ? -1 : ui.cursor;
    model.usage.accounts.forEach((account, index) => {
      for (const line of accountLines(account, model, c, { cursor: index === cursor, width })) {
        push(line);
      }
    });
    if (
      model.usage.activeDetectionReason !== undefined &&
      model.usage.activeAccountNumber === null
    ) {
      // The active account could not be identified. That is not a cosmetic gap:
      // every threshold in this tool is about the ACTIVE account.
      push(`  ${c.warn('active account not identified')} — ${model.usage.activeDetectionReason}`);
    }
    push(
      `  ${c.dim(
        `* the window that binds · thresholds: warn at ${100 - model.thresholds.warnPct}% used · ` +
          `soft at ${100 - model.thresholds.softPct}% · rotate at ${100 - model.thresholds.rotatePct}% · ` +
          `strategy ${model.strategy}`,
      )}`,
    );
  }
  push();

  // ---------------------------------------------------------- last action
  if (ui?.lastOutcome != null) {
    const done = ui.lastOutcome;
    push(
      `${c.bold('LAST ACTION')} ${done.ok ? c.good('ok') : c.bad('FAILED')} ` +
        `${c.dim(done.at.slice(11, 19))} ${done.dryRun ? c.bad('[dry run]') : ''}`,
    );
    push(`  ${done.title}`);
    for (const line of done.lines.slice(0, 4)) push(`  ${c.dim(line)}`);
    if (done.lines.length > 4) push(`  ${c.dim(`… ${done.lines.length - 4} more line(s)`)}`);
    push();
  }
  if (ui?.note != null) {
    push(`  ${c.warn(ui.note)}`);
    push();
  }

  // Everything below this point is the standing report. When a panel is open —
  // a confirmation, the strategy picker, the "why" panel — it replaces that
  // report rather than being appended to it, so the question is never off the
  // bottom of a short terminal. The accounts stay on screen above it, because
  // every one of those questions is about an account.
  const reportStartsAt = lines.length;

  // ------------------------------------------------------------ prediction
  push(c.bold('PREDICTION'));
  const active = model.usage === null ? null : (model.usage.accounts.find((a) => a.active) ?? null);
  if (active === null) {
    push(`  ${c.unknown(UNKNOWN)} — no active account to predict for`);
  } else {
    const prediction = model.predictions.find((p) => p.accountNumber === active.number);
    if (prediction === undefined) {
      push(`  ${c.unknown(UNKNOWN)} — no burn history has been collected for this account`);
    } else {
      for (const line of predictionLines(prediction, model.thresholds.rotatePct, c)) push(line);
    }
  }
  push();

  // -------------------------------------------------------------- unsaved
  push(c.bold('WORK IN FLIGHT'));
  if (model.workload === null) {
    push(`  ${c.unknown(UNKNOWN)} — ${model.workloadError ?? 'the trees have not been inspected'}`);
  } else {
    const { unsaved, activeSessions, needsHuman } = model.workload;
    if (unsaved.length === 0) {
      push(`  ${c.good('nothing unsaved')} — every watched tree is clean and pushed`);
    } else {
      push(
        `  ${c.warn(`${unsaved.length} tree(s) hold work that is not on a remote`)}` +
          (needsHuman.length > 0
            ? ` ${c.bad(`(${needsHuman.length} rotorcc cannot save on its own)`)}`
            : ''),
      );
      for (const tree of unsaved.slice(0, 6)) {
        const blocker =
          tree.midOperation !== null
            ? c.bad(`${tree.midOperation} in progress`)
            : tree.protectedBranch
              ? c.bad('protected branch')
              : tree.noRemote
                ? c.bad('no remote')
                : c.dim('savable');
        const ahead = tree.unpushedCommits === null ? UNKNOWN : `+${tree.unpushedCommits}`;
        push(
          `    ${padVisible(truncateVisible(tree.branch, 34), 34)} ` +
            `${padVisible(ahead, 7)} ${padVisible(`${tree.dirtyFiles} dirty`, 10)} ${blocker}`,
        );
      }
      if (unsaved.length > 6) push(`    ${c.dim(`… and ${unsaved.length - 6} more`)}`);
    }
    push(
      `  ${c.dim(
        `${activeSessions.length} session(s) written to in the last 5 minutes, ` +
          `${model.workload.sessions.length} known`,
      )}`,
    );
    if (model.safety !== null) {
      const verdict =
        model.safety.verdict === 'safe'
          ? c.good('safe to rotate')
          : model.safety.verdict === 'save-first'
            ? c.warn('save first')
            : c.bad('WOULD REFUSE TO ROTATE');
      push(`  ${verdict} — ${model.safety.reason}`);
    }
  }
  push();

  // ------------------------------------------------------------ durability
  push(c.bold('DURABILITY'));
  push(`  ${padVisible('snapshot', 12)} ${ago(model.lastSnapshotAt, model.now, c)}`);
  push(
    `  ${padVisible('store', 12)} ${
      model.store.lastCommit === null
        ? c.warn('no commits yet')
        : `${c.dim(model.store.lastCommit)} ${ago(model.store.lastCommitAt, model.now, c)}`
    }`,
  );
  const watcher =
    model.watcher.healthy === null
      ? c.unknown(model.watcher.detail)
      : model.watcher.healthy
        ? c.good(model.watcher.detail)
        : c.bad(model.watcher.detail);
  push(`  ${padVisible('watcher', 12)} ${watcher}`);
  if (model.flags.rotate) push(`  ${padVisible('flag', 12)} ${c.bad('ROTATE_NOW is raised')}`);
  if (model.flags.soft) push(`  ${padVisible('flag', 12)} ${c.warn('SOFT_CHECKPOINT is raised')}`);
  push();

  // ---------------------------------------------------------------- policy
  push(c.bold('NEXT SESSION'));
  if (model.flags.allExhausted) {
    // The loudest thing on the screen, because it is the one state where
    // rotorcc has nothing useful left to do and the operator has to act.
    push(`  ${c.bad('ALL ACCOUNTS OUT OF WEEKLY QUOTA — rotorcc has stopped')}`);
    push(
      `  ${c.dim('nothing will be rotated or started. Wait for a reset above, or add an account.')}`,
    );
  } else if (model.pendingHandover !== null) {
    push(
      `  ${c.accent(`will open on slot ${model.pendingHandover.slot}`)} ` +
        `${c.dim(`(expires ${model.pendingHandover.expiresAt.slice(11, 16)})`)}`,
    );
    push(`  ${c.dim(truncateVisible(model.pendingHandover.reason, width - 4))}`);
    push(`  ${c.dim('the running session keeps its own account; nothing is interrupted')}`);
  } else {
    push(`  ${c.dim('no handover queued — the next session opens on the current account')}`);
  }
  push();

  // ------------------------------------------------------------- decisions
  push(c.bold('RECENT DECISIONS'));
  if (model.decisions.length === 0) {
    push(`  ${c.unknown('none recorded')} — rotorcc has not decided anything yet on this machine`);
  } else {
    for (const entry of model.decisions.slice(0, 6)) push(`  ${decisionLine(entry, c)}`);
    if (model.consecutiveIdle >= 30) {
      // A long idle run is either completely fine or the 2026-08-19 defect
      // wearing a normal face. Say the number and let the operator compare it
      // against the headroom above.
      push(
        `  ${c.warn(`${model.consecutiveIdle} consecutive "do nothing" decisions`)} ` +
          `${c.dim('— check the headroom above is what you expect')}`,
      );
    }
  }

  if (ui !== undefined && ui.overlay.kind !== 'none') {
    return [
      ...lines.slice(0, reportStartsAt),
      ...overlayLines(ui, model, c, width).map((line) => truncateVisible(line, width)),
    ];
  }

  return lines;
}

/** A boxed panel. Plain characters, because this has to survive every terminal. */
function panel(title: string, body: string[], c: Palette, width: number): string[] {
  const inner = Math.max(20, Math.min(width, 96) - 4);
  const rule = '─'.repeat(inner);
  return [
    `  ┌─${rule}─┐`,
    `  │ ${padVisible(truncateVisible(c.bold(title), inner), inner)} │`,
    `  ├─${rule}─┤`,
    ...body.map((line) => `  │ ${padVisible(truncateVisible(line, inner), inner)} │`),
    `  └─${rule}─┘`,
  ];
}

/**
 * The open panel, whichever it is.
 *
 * Every one of these ends with the keys that answer it. A dialog whose escape
 * hatch is not written on it is a dialog somebody force-quits the terminal to
 * get out of.
 */
function overlayLines(ui: UiState, model: DashboardModel, c: Palette, width: number): string[] {
  switch (ui.overlay.kind) {
    case 'none':
      return [];

    case 'confirm':
      return panel(
        ui.overlay.action.label,
        [
          ...ui.overlay.prompt,
          '',
          c.bold('y / enter') + c.dim('  do it   ') + c.bold('any other key') + c.dim('  cancel'),
        ],
        c,
        width,
      );

    case 'strategy': {
      const index = ui.overlay.index;
      return panel(
        'rotation strategy',
        [
          ...STRATEGY_CHOICES.map((choice, i) => {
            const cursor = i === index ? c.accent('❯ ') : '  ';
            const current = choice === model.strategy ? '(in force)' : '';
            return (
              `${cursor}${padVisible(choice, 16)}${padVisible(c.dim(current), 12)}` +
              c.dim(STRATEGY_BLURBS[choice])
            );
          }),
          '',
          c.dim('This writes the config, the same as "rotorcc config set strategy".'),
          c.dim('Nothing is switched by it; the next decision uses the new rule.'),
          '',
          c.bold('↑↓/jk') +
            c.dim(' choose   ') +
            c.bold('enter') +
            c.dim(' apply   ') +
            c.bold('esc') +
            c.dim(' cancel'),
        ],
        c,
        width,
      );
    }

    case 'why':
      return panel('why has nothing happened?', whyBody(model, c), c, width);

    case 'outcome': {
      const done = ui.overlay.outcome;
      return panel(
        `${done.ok ? 'done' : 'FAILED'} — ${done.title}`,
        [
          ...(done.dryRun ? [c.bad('DRY RUN — nothing was written.'), ''] : []),
          ...(done.lines.length === 0 ? [c.dim('the command printed nothing')] : done.lines),
          '',
          c.dim('any key closes'),
        ],
        c,
        width,
      );
    }

    case 'help':
      return panel('keys', helpBody(c), c, width);
  }
}

const STRATEGY_BLURBS: Record<Strategy, string> = {
  'work-aware': 'only accounts big enough to FINISH what is running',
  best: 'largest weekly budget that is usable within the horizon',
  'next-available': 'the next slot in order, skipping exhausted ones',
  'consume-first': 'soonest reset first, to spend quota that would expire',
};

function helpBody(c: Palette): string[] {
  const row = (keys: string, what: string): string => `  ${padVisible(c.bold(keys), 14)}${what}`;
  return [
    c.dim('watching'),
    row('↑↓ / j k', 'move between accounts'),
    row('r', 'refresh now'),
    row('f', 'force a quota re-poll, ignoring the poll floor'),
    row('p', 'pause / resume the background refresh'),
    row('w', 'why has nothing happened — and what to do about it'),
    row('q', 'quit'),
    '',
    c.dim('acting — each one asks first, and shows you what it did'),
    row('enter / s', 'switch to the selected account now'),
    row('b', 'rotate to the best target now, by the current strategy'),
    row('d', 'disable / enable the selected account'),
    row('t', 'change the rotation strategy'),
    '',
    c.dim('Every action here runs the same code as the matching command:'),
    c.dim('switch → "rotorcc switch", d → "rotorcc accounts disable",'),
    c.dim('t → "rotorcc config set strategy", w/c → "rotorcc push-unpushed".'),
    '',
    c.dim('any key closes'),
  ];
}

/**
 * The panel that answers the question a dashboard usually cannot.
 *
 * Not prose reconstructed after the fact: the rejection list comes from the
 * same `selectTarget` the watcher calls, so what is on screen is what the
 * decision actually saw.
 */
function whyBody(model: DashboardModel, c: Palette): string[] {
  const body: string[] = [];

  const refusal = model.lastRefusal;
  body.push(c.dim('last decision that did not act'));
  if (refusal === null) {
    body.push('  none recorded — rotorcc has not refused or blocked anything yet');
  } else {
    body.push(`  ${refusal.at.slice(0, 16).replace('T', ' ')}  ${c.bad(refusal.kind)}`);
    for (const chunk of wrap(refusal.reason, 84)) body.push(`  ${chunk}`);
  }
  body.push('');

  body.push(c.dim(`what the "${model.strategy}" selector says right now`));
  if (model.selection === null) {
    body.push('  no reading to select over');
  } else {
    body.push(`  ${model.selection.reason.slice(0, 200)}`);
    for (const entry of model.selection.rejected) {
      body.push(`  ${c.dim(`#${entry.account.number}`)} ${entry.reason}`);
    }
  }
  body.push('');

  if (model.raisedFlags.length > 0) {
    body.push(c.dim('flags raised'));
    for (const flag of model.raisedFlags) {
      body.push(`  ${c.warn(flag.name)} ${c.dim(flag.raisedAt.slice(11, 16))}`);
      for (const chunk of wrap(flag.reason, 84)) body.push(`    ${chunk}`);
    }
    body.push('');
  }

  if (model.safety !== null && model.safety.verdict !== 'safe') {
    body.push(c.dim('work in flight'));
    body.push(
      `  ${model.safety.verdict === 'refuse' ? c.bad('would refuse') : c.warn('save first')} — ${model.safety.reason}`,
    );
    body.push('');
  }

  body.push(
    c.bold('c') +
      c.dim(' checkpoint everything now   ') +
      c.bold('x') +
      c.dim(' clear raised flags   ') +
      c.bold('f') +
      c.dim(' re-poll   ') +
      c.bold('esc') +
      c.dim(' close'),
  );
  return body;
}

/** Break a long reason across lines without cutting a word in half. */
function wrap(text: string, width: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    if (current === '') current = word;
    else if (current.length + 1 + word.length <= width) current = `${current} ${word}`;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current !== '') lines.push(current);
  return lines.slice(0, 6);
}

/**
 * The width at which the spend bars fit beside both figures.
 *
 * Below it the bars are dropped and the two percentages stay. Given a choice
 * between a picture of one number and both numbers, both numbers win: the
 * defect this layout exists to prevent was caused by seeing one window and
 * inferring the other.
 */
const BAR_WIDTH_THRESHOLD = 104;

/**
 * One window's cell.
 *
 * `*` marks the window that binds. It is printed as well as, never instead of,
 * the other window — and the row's trailer says the same thing in words, so a
 * terminal narrow enough to truncate the trailer still shows which one is the
 * constraint.
 */
function windowCell(
  window: WindowUsed,
  thresholds: DashboardModel['thresholds'],
  c: Palette,
  showBar: boolean,
): string {
  const mark = window.binding ? c.accent('*') : ' ';
  const name = c.dim(padVisible(window.name, 3));
  if (window.usedPct === null) {
    // No bar and no number. An empty bar and a bar for a genuine 0% look
    // identical, and only one of them is a measurement — and under a used
    // convention the harmless-looking `?? 0` renders an unmeasured account as
    // "0% used", which reads as completely fresh and makes it the most
    // attractive rotation target on the screen.
    return `${mark}${name}${c.unknown(padVisible(UNKNOWN, showBar ? 17 : 9))}`;
  }
  const headroom = window.headroomPct ?? 0;
  const tone =
    headroom <= thresholds.rotatePct ? c.bad : headroom <= thresholds.warnPct ? c.warn : c.good;
  const figure = tone(padVisible(`${window.usedPct.toFixed(0)}% used`, 9));
  return showBar ? `${mark}${name}${bar(window.usedPct, 7)} ${figure}` : `${mark}${name}${figure}`;
}

function accountLines(
  account: AccountReading,
  model: DashboardModel,
  c: Palette,
  options: { cursor: boolean; width: number },
): string[] {
  const pointer = options.cursor ? c.accent('❯') : ' ';
  const marker = account.active ? c.accent('▸') : ' ';
  const label = account.alias ?? account.email ?? `account ${account.number}`;
  const name = padVisible(truncateVisible(label, 18), 18);
  const number = padVisible(`#${account.number}`, 4);
  const showBar = options.width >= BAR_WIDTH_THRESHOLD;

  const age =
    account.usageAgeMs === null || account.usageAgeMs === undefined
      ? ''
      : account.usageAgeMs > 120_000
        ? ` ${c.dim(`(${formatDuration(account.usageAgeMs)} old)`)}`
        : '';
  const tags =
    (account.disabled === true ? c.dim(' [disabled]') : '') +
    (account.kind === 'api-key' ? c.dim(' [api-key]') : '');

  // BOTH windows, always, each named and each reported as spent. Collapsing to
  // the binding one is what made a 5-hour window at 99% and a week at 72% read
  // as the same account — and only one of those is a reason to stop working.
  const windows = windowsUsedOf(account);
  const headline = windows
    .slice(0, 2)
    .map((w) => windowCell(w, model.thresholds, c, showBar))
    .join(' ');
  const binding = headroomIsKnown(account)
    ? c.dim(formatBinding(account))
    : c.unknown(formatBinding(account));

  const lines = [`${pointer}${marker} ${number}${name} ${headline} ${binding}${age}${tags}`];
  for (const extra of windows.slice(2)) {
    // Per-model weekly caps. A full one stops the work exactly as hard as the
    // account-wide window, so it is never dropped — only ranked below.
    lines.push(
      `${' '.repeat(7)}${padVisible('', 18)} ${windowCell(extra, model.thresholds, c, showBar)}`,
    );
  }
  return lines;
}

function predictionLines(prediction: AccountPrediction, rotatePct: number, c: Palette): string[] {
  const lines: string[] = [];

  if (prediction.rate.pctPerHour === null) {
    lines.push(`  ${c.unknown(UNKNOWN)} — ${prediction.rate.basis}`);
  } else if (prediction.prediction.at === null) {
    lines.push(`  ${c.dim('no projection')} — ${prediction.prediction.detail}`);
  } else {
    const when =
      prediction.prediction.inMs === null ? UNKNOWN : formatDuration(prediction.prediction.inMs);
    const colour =
      prediction.prediction.inMs !== null && prediction.prediction.inMs < 30 * 60_000
        ? c.bad
        : c.warn;
    lines.push(`  reaches ${rotatePct}% headroom in ${colour(when)}`);
    lines.push(
      `  ${c.dim(
        `${prediction.rate.pctPerHour.toFixed(1)} points/hour · ${confidenceWord(prediction.rate.confidence, c)} · ${prediction.rate.basis}`,
      )}`,
    );
  }

  const finish = prediction.finishesFirst;
  const verdict =
    finish.answer === null
      ? c.unknown(UNKNOWN)
      : finish.answer
        ? c.good('likely yes')
        : c.bad('likely no');
  lines.push(`  work finishes first? ${verdict} ${c.dim(`— ${finish.detail}`)}`);
  return lines;
}

function confidenceWord(confidence: string, c: Palette): string {
  if (confidence === 'none') return c.unknown('no confidence');
  return `${confidence} confidence`;
}

function decisionLine(entry: DecisionEntry, c: Palette): string {
  const kindColour =
    entry.kind === 'rotated'
      ? c.accent
      : entry.kind === 'refused' || entry.kind === 'blocked' || entry.kind === 'error'
        ? c.bad
        : entry.kind === 'checkpointed' || entry.kind === 'warned'
          ? c.warn
          : c.dim;
  const time = c.dim(entry.at.slice(11, 16));
  const kind = padVisible(kindColour(entry.kind), 14);
  const headroom =
    entry.headroomPct === null
      ? c.unknown(padVisible(UNKNOWN, 8))
      : padVisible(`${entry.headroomPct.toFixed(0)}%`, 8);
  const dry = entry.dryRun ? c.bad('[dry] ') : '';
  return `${time} ${kind}${headroom}${dry}${c.dim(truncateVisible(entry.reason, 90))}`;
}

/**
 * A headroom meter.
 *
 * Only ever called for a KNOWN value — there is no "empty bar" state, because
 * an empty bar and a bar for an account at 0% are visually identical and one of
 * those is a measurement.
 */
/** A bar that fills as the window is SPENT. Never drawn for an unknown. */
export function bar(usedPct: number, width = 16): string {
  const filled = Math.max(0, Math.min(width, Math.round((usedPct / 100) * width)));
  return `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`;
}

function ago(iso: string | null, now: Date, c: Palette): string {
  if (iso === null) return c.unknown('never');
  const ms = now.getTime() - Date.parse(iso);
  if (!Number.isFinite(ms)) return c.unknown(UNKNOWN);
  return c.dim(`${formatDuration(Math.max(0, ms))} ago`);
}

/**
 * The one-line key at the bottom of the live view.
 *
 * The acting keys are named on it, not hidden behind `?`. A dashboard whose
 * controls are undiscoverable is a dashboard people keep a second terminal open
 * beside, which is the thing this pane exists to stop.
 */
export function footer(c: Palette, state: { paused: boolean; readOnly?: boolean }): string {
  if (state.readOnly === true) {
    return c.dim('read-only: this is not an interactive terminal · rotorcc never invents a number');
  }
  return c.dim(
    `↑↓ pick · enter switch · b rotate best · d disable · f re-poll · t strategy · ` +
      `w why · ? keys · p ${state.paused ? 'resume' : 'pause'} · q quit`,
  );
}
