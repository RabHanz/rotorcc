/**
 * Assembling the dashboard model from the live machine.
 *
 * Kept apart from `render.ts` so the rendering stays a pure function of data,
 * and apart from `app.ts` so the gathering can be tested without a terminal.
 *
 * Every gather step is individually fallible and individually reported. A
 * failure to inspect worktrees must not take the account panel down with it —
 * the point of a dashboard during an incident is that the parts that still work
 * keep working, and the parts that do not say so.
 */
import { existsSync } from 'node:fs';

import type { Config } from '../config/schema.js';
import { AccountManager } from '../accounts/manager.js';
import { type Selection, selectTarget } from '../accounts/select.js';
import { BurnStore, burnRateFrom, predictThreshold, willFinishFirst } from '../core/burn.js';
import { type DecisionEntry, DecisionJournal } from '../core/history.js';
import { run } from '../core/proc.js';
import {
  FLAG_ALL_EXHAUSTED,
  FLAG_ROTATE_NOW,
  FLAG_SOFT_CHECKPOINT,
  type Store,
} from '../core/state.js';
import { PendingSwitchStore } from '../core/nextSession.js';
import type { UsageReading } from '../core/usage.js';
import {
  type WorkloadSnapshot,
  assessRotationSafety,
  collectWorkload,
  estimateHeadroomNeeded,
} from '../core/workload.js';
import { VERSION } from '../version.js';
import type { AccountPrediction, DashboardModel } from './render.js';

export interface BuildModelOptions {
  config: Config;
  store: Store;
  manager: AccountManager;
  dryRun: boolean;
  /** Force a quota re-poll even inside the poll floor. */
  force?: boolean;
  now?: () => Date;
  /** Skips the worktree scan, which is the expensive part of a redraw. */
  skipWorkload?: boolean;
  /** Carried forward when the workload scan is skipped this cycle. */
  previousWorkload?: WorkloadSnapshot | null;
}

export async function buildDashboardModel(options: BuildModelOptions): Promise<DashboardModel> {
  const { config, store, manager } = options;
  const now = options.now ?? (() => new Date());
  const nowDate = now();

  let usage: UsageReading | null = null;
  let usageError: string | null = null;
  try {
    usage = await manager.readUsage({ force: options.force ?? false });
  } catch (err) {
    usageError = (err as Error).message.slice(0, 200);
  }

  const noAccountsHint =
    usage !== null && usage.accounts.length === 0
      ? 'Add one with "rotorcc accounts add", or import an existing switcher\'s with ' +
        '"rotorcc accounts import --from-cswap".'
      : null;

  // Record a burn sample for every account we could actually measure. Doing it
  // here means the TUI feeds the same history the watcher does, so a machine
  // that is mostly watched through the dashboard still builds a prediction.
  const burn = new BurnStore(store.dir);
  if (usage !== null) {
    for (const account of usage.accounts) burn.record(account, nowDate.getTime());
  }

  let workload: WorkloadSnapshot | null = options.previousWorkload ?? null;
  let workloadError: string | null = null;
  if (options.skipWorkload !== true) {
    try {
      workload = await collectWorkload(config, { now: () => nowDate.getTime() });
    } catch (err) {
      workload = null;
      workloadError = (err as Error).message.slice(0, 200);
    }
  }

  const safety = workload === null ? null : assessRotationSafety(workload);

  const predictions: AccountPrediction[] = [];
  if (usage !== null) {
    for (const account of usage.accounts) {
      const rate = burnRateFrom(burn.series(account.number), nowDate.getTime());
      const prediction = predictThreshold(
        account.headroomPct,
        rate,
        config.thresholds.rotatePct,
        nowDate.getTime(),
        account.bindingWindow,
      );
      const needed =
        workload === null
          ? { estimatedPct: null }
          : estimateHeadroomNeeded(workload, rate.pctPerHour, {
              minimumPct: config.minTargetHeadroomPct,
            });
      predictions.push({
        accountNumber: account.number,
        rate,
        prediction,
        finishesFirst: willFinishFirst(
          prediction,
          needed.estimatedPct,
          account.headroomPct,
          account.bindingWindow,
        ),
      });
    }
  }

  const state = store.readState();
  const storeInfo = await readStoreTip(config);
  const watcher = await watcherHealth(config);

  const journal = new DecisionJournal(store.dir);
  const recent = journal.recent(60);

  // The selector, run over the same reading with the same options the watcher
  // uses. This is what makes the "why has nothing happened?" panel an answer
  // rather than a guess: the rejection reasons on screen are the ones the
  // decision itself produced, not prose written to sound like them.
  const selection: Selection | null =
    usage === null
      ? null
      : selectTarget(usage, {
          strategy: config.strategy,
          activeNumber: usage.activeAccountNumber,
          minHeadroomPct: config.minTargetHeadroomPct,
          models: config.models,
          now: () => nowDate,
        });

  const raisedFlags: DashboardModel['raisedFlags'] = [];
  for (const name of [FLAG_ROTATE_NOW, FLAG_SOFT_CHECKPOINT, FLAG_ALL_EXHAUSTED]) {
    const payload = store.readFlag(name);
    if (payload === null) continue;
    raisedFlags.push({ name, reason: payload.reason, raisedAt: payload.raisedAt });
  }

  return {
    now: nowDate,
    version: VERSION,
    usage,
    usageError,
    thresholds: config.thresholds,
    predictions,
    workload,
    workloadError,
    safety,
    store: {
      path: config.storePath,
      lastCommit: storeInfo.commit,
      lastCommitAt: storeInfo.at,
    },
    lastSnapshotAt: state.lastSnapshotAt,
    watcher,
    decisions: recent.slice(0, 8),
    consecutiveIdle: journal.consecutiveIdle(),
    strategy: config.strategy,
    selection,
    // The most recent decision that did NOT act. A screen full of "idle" is
    // exactly what an operator should not have to read through to find the
    // moment rotorcc decided against doing the thing they expected.
    lastRefusal:
      recent.find(
        (entry: DecisionEntry) =>
          entry.kind === 'refused' || entry.kind === 'blocked' || entry.kind === 'error',
      ) ?? null,
    raisedFlags,
    flags: {
      soft: store.readFlag(FLAG_SOFT_CHECKPOINT) !== null,
      rotate: store.readFlag(FLAG_ROTATE_NOW) !== null,
      allExhausted: store.readFlag(FLAG_ALL_EXHAUSTED) !== null,
    },
    pendingHandover: (() => {
      // `peek`, never `consume`: the dashboard must not be able to swallow the
      // intent that SessionStart is waiting for.
      const pending = new PendingSwitchStore(store.dir).peek();
      if (pending === null || pending.dryRun) return null;
      return { slot: pending.slot, reason: pending.reason, expiresAt: pending.expiresAt };
    })(),
    dryRun: options.dryRun,
    refreshing: false,
    noAccountsHint,
  };
}

async function readStoreTip(config: Config): Promise<{ commit: string | null; at: string | null }> {
  if (!existsSync(config.storePath)) return { commit: null, at: null };
  try {
    const log = await run([...config.commands.git, 'log', '-1', '--format=%h %s|%cI'], {
      cwd: config.storePath,
      timeoutMs: 15_000,
      okCodes: [128],
    });
    const [subject = '', when = ''] = log.stdout.trim().split('|');
    return { commit: subject === '' ? null : subject, at: when === '' ? null : when };
  } catch {
    return { commit: null, at: null };
  }
}

/**
 * Is the every-minute watcher actually running?
 *
 * `healthy: null` means rotorcc could not tell, and that renders as unknown
 * rather than as either a tick or a cross. A dashboard claiming the watcher is
 * fine when it has not checked is the failure this whole tool is about.
 */
async function watcherHealth(config: Config): Promise<{ detail: string; healthy: boolean | null }> {
  void config;
  try {
    if (process.platform === 'linux') {
      const result = await run(['systemctl', '--user', 'is-active', 'rotorcc.timer'], {
        timeoutMs: 10_000,
        okCodes: [1, 3, 4],
      });
      const status = result.stdout.trim();
      if (status === 'active') return { detail: 'systemd timer active', healthy: true };
      if (status === '') return { detail: 'watcher status unavailable', healthy: null };
      return { detail: `systemd timer ${status}`, healthy: false };
    }
    if (process.platform === 'darwin') {
      const result = await run(['launchctl', 'list'], { timeoutMs: 10_000, okCodes: [1] });
      if (result.stdout === '') return { detail: 'watcher status unavailable', healthy: null };
      return result.stdout.includes('dev.rotorcc.watch')
        ? { detail: 'launchd agent loaded', healthy: true }
        : { detail: 'launchd agent not loaded', healthy: false };
    }
    if (process.platform === 'win32') {
      const result = await run(['schtasks', '/Query', '/TN', 'rotorcc-watch'], {
        timeoutMs: 10_000,
        okCodes: [1],
      });
      return result.ok
        ? { detail: 'scheduled task present', healthy: true }
        : { detail: 'scheduled task not found', healthy: false };
    }
  } catch {
    return { detail: 'watcher status could not be checked', healthy: null };
  }
  return { detail: 'no scheduler adapter for this platform', healthy: null };
}
