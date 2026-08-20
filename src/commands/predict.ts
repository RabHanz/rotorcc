/**
 * `rotorcc predict` — when does this run out, and will the work finish first?
 *
 * The whole command is an exercise in saying what is not known. It has three
 * distinct not-knowing states and each one prints differently, because
 * collapsing them is how a prediction screen becomes a liar:
 *
 *   - no burn history at all          "not enough history yet, N samples"
 *   - history, but headroom not falling "not falling; nothing to project"
 *   - history and falling, low confidence "in ~40m, LOW confidence, here is why"
 *
 * The confidence and the basis are printed every single time, not just when
 * they are poor. A number without them is the kind of output somebody screenshots
 * and plans a day around.
 */
import type { Config } from '../config/schema.js';
import type { AccountManager } from '../accounts/manager.js';
import {
  type BurnRate,
  BurnStore,
  burnRateFrom,
  formatDuration,
  predictThreshold,
  willFinishFirst,
} from '../core/burn.js';
import type { Store } from '../core/state.js';
import { headroomIsKnown, usedPctOf, windowLines, windowsUsedOf } from '../core/usage.js';
import { collectWorkload, estimateHeadroomNeeded } from '../core/workload.js';

export interface PredictOptions {
  config: Config;
  store: Store;
  manager: AccountManager;
  json: boolean;
  force: boolean;
  out: (line: string) => void;
}

export async function runPredict(options: PredictOptions): Promise<number> {
  const { config, store, manager, out } = options;
  const reading = await manager.readUsage({ force: options.force });
  const burn = new BurnStore(store.dir);

  // Record before predicting, so the very first `predict` on a machine
  // contributes its own sample rather than only reporting the absence of any.
  for (const account of reading.accounts) burn.record(account);

  let workload = null;
  let workloadError: string | null = null;
  try {
    workload = await collectWorkload(config);
  } catch (err) {
    workloadError = (err as Error).message.slice(0, 160);
  }

  const rows = reading.accounts.map((account) => {
    const rate = burnRateFrom(burn.series(account.number));
    const prediction = predictThreshold(
      account.headroomPct,
      rate,
      config.thresholds.rotatePct,
      Date.now(),
      account.bindingWindow,
    );
    const requirement =
      workload === null
        ? {
            estimatedPct: null,
            basis: workloadError ?? 'work in flight not inspected',
            confidence: 'none' as const,
          }
        : estimateHeadroomNeeded(workload, rate.pctPerHour, {
            minimumPct: config.minTargetHeadroomPct,
          });
    const finish = willFinishFirst(
      prediction,
      requirement.estimatedPct,
      account.headroomPct,
      account.bindingWindow,
    );
    return { account, rate, prediction, requirement, finish };
  });

  if (options.json) {
    out(
      JSON.stringify(
        {
          observedAt: reading.observedAt,
          rotateThresholdPct: config.thresholds.rotatePct,
          accounts: rows.map((r) => ({
            slot: r.account.number,
            active: r.account.active,
            usedPct: usedPctOf(r.account),
            headroomPct: headroomIsKnown(r.account) ? r.account.headroomPct : null,
            headroomKnown: headroomIsKnown(r.account),
            bindingWindow: headroomIsKnown(r.account) ? r.account.bindingWindow : null,
            // Always carries 5h and 7d, each null when unmeasured.
            windows: windowsUsedOf(r.account),
            burnPctPerHour: r.rate.pctPerHour,
            burnConfidence: r.rate.confidence,
            burnSamples: r.rate.samples,
            burnSpanSeconds: Math.round(r.rate.spanMs / 1000),
            burnRSquared: r.rate.rSquared,
            burnBasis: r.rate.basis,
            reachesThresholdAt: r.prediction.at,
            reachesThresholdInSeconds:
              r.prediction.inMs === null ? null : Math.round(r.prediction.inMs / 1000),
            predictionConfidence: r.prediction.confidence,
            predictionDetail: r.prediction.detail,
            estimatedHeadroomNeededPct: r.requirement.estimatedPct,
            estimateBasis: r.requirement.basis,
            workFinishesFirst: r.finish.answer,
            workFinishesFirstDetail: r.finish.detail,
          })),
        },
        null,
        2,
      ),
    );
    return 0;
  }

  if (rows.length === 0) {
    out('rotorcc manages no accounts, so there is nothing to predict.');
    return 1;
  }

  for (const row of rows) {
    const label = row.account.alias ?? row.account.email ?? `account ${row.account.number}`;
    out(`${row.account.active ? '>' : ' '} ${label} (slot ${row.account.number})`);

    // Both windows, always. The projection below is about the window that
    // binds, and reading that number without the other one beside it is how
    // "this account is nearly gone" got said about an account whose week was
    // perfectly healthy.
    out('    spent');
    for (const line of windowLines(row.account, '      ')) out(line);

    if (!headroomIsKnown(row.account)) {
      out(`    binding       unknown — ${row.account.unknownReason ?? 'not measured'}`);
      out('');
      continue;
    }

    out(`    burn rate     ${describeRate(row.rate)}`);
    out(
      `    hits ${String(config.thresholds.rotatePct).padStart(2)}%      ${
        row.prediction.at === null
          ? `unknown — ${row.prediction.detail}`
          : `${formatDuration(row.prediction.inMs ?? 0)} (${row.prediction.confidence} confidence)`
      }`,
    );
    out(
      `    needs         ${
        row.requirement.estimatedPct === null
          ? `unknown — ${row.requirement.basis}`
          : `~${row.requirement.estimatedPct.toFixed(0)}% to finish — ${row.requirement.basis}`
      }`,
    );
    out(
      `    finishes?     ${
        row.finish.answer === null ? 'unknown' : row.finish.answer ? 'likely yes' : 'likely no'
      } — ${row.finish.detail}`,
    );
    out('');
  }

  out('Every figure above is an extrapolation of a bursty process. Treat the');
  out('confidence as part of the number, not a footnote to it.');
  return 0;
}

function describeRate(rate: BurnRate): string {
  if (rate.pctPerHour === null) return `unknown — ${rate.basis}`;
  if (rate.pctPerHour <= 0) return `not falling (${rate.samples} samples)`;
  return `${rate.pctPerHour.toFixed(1)} points/hour, ${rate.confidence} confidence — ${rate.basis}`;
}
