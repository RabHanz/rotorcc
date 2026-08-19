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
import { type AccountReading, type UsageReading, headroomIsKnown } from '../core/usage.js';
import type { RotationSafety, WorkloadSnapshot } from '../core/workload.js';
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
  flags: { soft: boolean; rotate: boolean };
  /** True when this rotorcc is configured to never actually act. */
  dryRun: boolean;
  /** True when a refresh is in flight, so the header can say so. */
  refreshing: boolean;
  /** Set when the account store is empty and nothing can be measured. */
  noAccountsHint: string | null;
}

export interface RenderOptions {
  palette: Palette;
  width: number;
  height?: number;
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
  const right = `${flags.join(' ')} ${c.dim(stamp)}`.trim();
  push(`${left}${' '.repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(right)))}${right}`);
  push();

  // -------------------------------------------------------------- accounts
  push(c.bold('ACCOUNTS'));
  if (model.usage === null) {
    push(`  ${c.bad('could not read any account')} — ${model.usageError ?? 'reason not recorded'}`);
    if (model.noAccountsHint !== null) push(`  ${c.dim(model.noAccountsHint)}`);
  } else if (model.usage.accounts.length === 0) {
    push(`  ${c.warn('rotorcc manages no accounts yet')}`);
    if (model.noAccountsHint !== null) push(`  ${c.dim(model.noAccountsHint)}`);
  } else {
    for (const account of model.usage.accounts) {
      for (const line of accountLines(account, model, c)) push(line);
    }
    if (model.usage.activeDetectionReason !== undefined && model.usage.activeAccountNumber === null) {
      // The active account could not be identified. That is not a cosmetic gap:
      // every threshold in this tool is about the ACTIVE account.
      push(`  ${c.warn('active account not identified')} — ${model.usage.activeDetectionReason}`);
    }
    push(
      `  ${c.dim(
        `thresholds: warn ${model.thresholds.warnPct}% · soft ${model.thresholds.softPct}% · rotate ${model.thresholds.rotatePct}%`,
      )}`,
    );
  }
  push();

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

  return lines;
}

function accountLines(account: AccountReading, model: DashboardModel, c: Palette): string[] {
  const marker = account.active ? c.accent('▸') : ' ';
  const label = account.alias ?? account.email ?? `account ${account.number}`;
  const name = padVisible(truncateVisible(label, 26), 26);
  const number = padVisible(`#${account.number}`, 4);

  if (!headroomIsKnown(account)) {
    // The rule, made concrete. No bar, no percentage, no implication.
    const reason = account.unknownReason ?? 'not measured';
    const tag = account.disabled === true ? c.dim(' [disabled]') : '';
    return [`  ${marker} ${number}${name} ${c.unknown(padVisible(UNKNOWN, 24))} ${c.dim(reason)}${tag}`];
  }

  const level =
    account.headroomPct <= model.thresholds.rotatePct
      ? c.bad
      : account.headroomPct <= model.thresholds.warnPct
        ? c.warn
        : c.good;
  const meter = `${bar(account.headroomPct)} ${level(`${account.headroomPct.toFixed(0).padStart(3)}%`)}`;
  const resets =
    account.bindingResetsAt === undefined
      ? c.dim('reset unknown')
      : c.dim(`resets ${account.bindingResetsAt.slice(0, 16).replace('T', ' ')}`);
  const age =
    account.usageAgeMs === null || account.usageAgeMs === undefined
      ? ''
      : account.usageAgeMs > 120_000
        ? ` ${c.dim(`(${formatDuration(account.usageAgeMs)} old)`)}`
        : '';
  const tags =
    (account.disabled === true ? c.dim(' [disabled]') : '') +
    (account.kind === 'api-key' ? c.dim(' [api-key]') : '');

  return [
    `  ${marker} ${padVisible(`#${account.number}`, 4)}${name} ${meter} ` +
      `${c.dim(padVisible(account.bindingWindow, 7))} ${resets}${age}${tags}`,
  ];
}

function predictionLines(
  prediction: AccountPrediction,
  rotatePct: number,
  c: Palette,
): string[] {
  const lines: string[] = [];

  if (prediction.rate.pctPerHour === null) {
    lines.push(`  ${c.unknown(UNKNOWN)} — ${prediction.rate.basis}`);
  } else if (prediction.prediction.at === null) {
    lines.push(`  ${c.dim('no projection')} — ${prediction.prediction.detail}`);
  } else {
    const when =
      prediction.prediction.inMs === null ? UNKNOWN : formatDuration(prediction.prediction.inMs);
    const colour =
      prediction.prediction.inMs !== null && prediction.prediction.inMs < 30 * 60_000 ? c.bad : c.warn;
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
export function bar(headroomPct: number, width = 16): string {
  const filled = Math.max(0, Math.min(width, Math.round((headroomPct / 100) * width)));
  return `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`;
}

function ago(iso: string | null, now: Date, c: Palette): string {
  if (iso === null) return c.unknown('never');
  const ms = now.getTime() - Date.parse(iso);
  if (!Number.isFinite(ms)) return c.unknown(UNKNOWN);
  return c.dim(`${formatDuration(Math.max(0, ms))} ago`);
}

/** The one-line key at the bottom of the live view. */
export function footer(c: Palette, paused: boolean): string {
  return c.dim(
    `q quit · r refresh now · p ${paused ? 'resume' : 'pause'} · rotorcc never invents a number: ` +
      '"unknown" means unknown',
  );
}
