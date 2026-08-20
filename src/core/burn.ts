/**
 * Burn rate and prediction: when will the active account hit the threshold?
 *
 * The rule this module is written against is the one that cost a session: a
 * tool that reports confidently while knowing nothing is worse than no tool.
 * So every function here can return "I do not know", and every prediction
 * carries the sample it was built from and a confidence that is never inflated.
 *
 * The method is a least-squares fit over recent headroom samples for ONE
 * account and ONE quota window. Simple, and simple on purpose:
 *
 *   - Real agent usage is bursty. A fancier model fitted to burst data produces
 *     a narrower-looking interval around an answer that is no better.
 *   - The consumer of this is a human deciding whether to start another task.
 *     "About 40 minutes, low confidence, from 6 samples over 25 minutes" is
 *     actionable. A number with three decimals is not more actionable, only
 *     more believable than it deserves.
 *
 * Samples are per (account, window-key). A window key is the reset time, so a
 * window that rolls over starts a fresh series instead of fitting a line
 * through a discontinuity — the single most likely way this could produce a
 * confidently wrong answer.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';

import { writeJsonAtomic } from '../accounts/atomic.js';
import { type AccountReading, headroomIsKnown } from './usage.js';

const sampleSchema = z.object({
  /** Epoch milliseconds. */
  at: z.number(),
  headroomPct: z.number(),
});

const seriesSchema = z.object({
  /** The quota window these samples belong to: reset time, or window name. */
  windowKey: z.string(),
  /** The window that was binding when sampled, for the human-readable output. */
  windowName: z.string(),
  samples: z.array(sampleSchema).default([]),
});

const historySchema = z.object({
  version: z.literal(1).default(1),
  /** Keyed by account number as a string. */
  accounts: z.record(z.string(), seriesSchema).default({}),
});

export type BurnSample = z.infer<typeof sampleSchema>;
export type BurnSeries = z.infer<typeof seriesSchema>;
export type BurnHistory = z.infer<typeof historySchema>;

/** Keep this many samples per series. At a 60s tick that is about two hours. */
export const MAX_SAMPLES = 120;
/** Ignore samples older than this: a burn rate from four hours ago is not now. */
export const SAMPLE_HORIZON_MS = 3 * 3_600_000;
/** Below this many usable samples there is no rate, only noise. */
export const MIN_SAMPLES_FOR_RATE = 3;
/** Below this span, two samples minutes apart give a wildly overfitted slope. */
export const MIN_SPAN_MS = 8 * 60_000;

export class BurnStore {
  readonly path: string;

  constructor(stateDir: string) {
    this.path = join(stateDir, 'burn-history.json');
  }

  read(): BurnHistory {
    if (!existsSync(this.path)) return { version: 1, accounts: {} };
    try {
      const parsed = historySchema.safeParse(JSON.parse(readFileSync(this.path, 'utf8')));
      return parsed.success ? parsed.data : { version: 1, accounts: {} };
    } catch {
      // Derived data. Losing it costs a prediction, not correctness, and
      // refusing to run because a history file went bad would be the tool
      // failing closed on something that does not matter.
      return { version: 1, accounts: {} };
    }
  }

  write(history: BurnHistory): void {
    writeJsonAtomic(this.path, history);
  }

  /**
   * Record one observation.
   *
   * An account whose headroom is unknown records NOTHING. Recording a
   * placeholder zero would put a cliff into the series and make the next
   * prediction say the account dies in ninety seconds.
   */
  record(account: AccountReading, atMs = Date.now()): void {
    if (!headroomIsKnown(account)) return;
    const history = this.read();
    const key = String(account.number);
    const windowKey = account.bindingResetsAt ?? `${account.bindingWindow}@unknown`;
    const existing = history.accounts[key];

    // A different window means the old series is describing a different budget.
    // Fitting across the boundary is how "12% left" becomes "you have 9 hours".
    const series: BurnSeries =
      existing !== undefined && existing.windowKey === windowKey
        ? existing
        : { windowKey, windowName: account.bindingWindow, samples: [] };

    series.windowName = account.bindingWindow;
    series.samples.push({ at: atMs, headroomPct: account.headroomPct });
    series.samples = series.samples
      .filter((s) => atMs - s.at <= SAMPLE_HORIZON_MS)
      .slice(-MAX_SAMPLES);
    history.accounts[key] = series;
    this.write(history);
  }

  series(accountNumber: number): BurnSeries | null {
    return this.read().accounts[String(accountNumber)] ?? null;
  }

  forget(accountNumber: number): void {
    const history = this.read();
    delete history.accounts[String(accountNumber)];
    this.write(history);
  }
}

export type Confidence = 'high' | 'medium' | 'low' | 'none';

export interface BurnRate {
  /** Headroom lost per hour. Positive means burning; null means unknown. */
  pctPerHour: number | null;
  confidence: Confidence;
  /** How many samples the fit used. */
  samples: number;
  /** The wall-clock span those samples cover, in milliseconds. */
  spanMs: number;
  /**
   * Coefficient of determination, 0-1. How much of the variation the straight
   * line explains. Bursty usage scores low, and that is the honest signal that
   * the prediction below it should not be leaned on.
   */
  rSquared: number | null;
  /** One line saying what this is and is not. Always populated. */
  basis: string;
}

/**
 * Fit a burn rate to a series.
 *
 * Returns a null rate — never zero — when there is not enough to fit. Zero
 * means "measured, and not burning", which is a completely different statement
 * from "I have no idea", and conflating them is how a prediction screen says
 * "never runs out" about an account nobody has looked at.
 */
export function burnRateFrom(series: BurnSeries | null, nowMs = Date.now()): BurnRate {
  if (series === null || series.samples.length === 0) {
    return {
      pctPerHour: null,
      confidence: 'none',
      samples: 0,
      spanMs: 0,
      rSquared: null,
      basis: 'no headroom history for this account yet',
    };
  }

  const usable = series.samples.filter((s) => nowMs - s.at <= SAMPLE_HORIZON_MS);
  if (usable.length < MIN_SAMPLES_FOR_RATE) {
    return {
      pctPerHour: null,
      confidence: 'none',
      samples: usable.length,
      spanMs: spanOf(usable),
      rSquared: null,
      basis: `only ${usable.length} recent sample(s); ${MIN_SAMPLES_FOR_RATE} are needed for a rate`,
    };
  }

  const spanMs = spanOf(usable);
  if (spanMs < MIN_SPAN_MS) {
    return {
      pctPerHour: null,
      confidence: 'none',
      samples: usable.length,
      spanMs,
      rSquared: null,
      basis: `samples span only ${Math.round(spanMs / 60_000)} minute(s); too short to extrapolate`,
    };
  }

  const fit = leastSquares(usable);
  // Slope is headroom per millisecond and headroom falls, so burn is negative
  // slope. A rising series (a window that reset, a manual top-up) yields a
  // negative burn, which is reported as "not burning" rather than as a
  // prediction that headroom grows forever.
  const pctPerHour = -fit.slope * 3_600_000;

  const confidence = confidenceFor(usable.length, spanMs, fit.rSquared);
  return {
    pctPerHour,
    confidence,
    samples: usable.length,
    spanMs,
    rSquared: fit.rSquared,
    basis:
      `least-squares fit over ${usable.length} samples spanning ` +
      `${Math.round(spanMs / 60_000)} minutes (R²=${fit.rSquared.toFixed(2)})`,
  };
}

function spanOf(samples: BurnSample[]): number {
  if (samples.length < 2) return 0;
  const times = samples.map((s) => s.at);
  return Math.max(...times) - Math.min(...times);
}

/**
 * Confidence, decided by the three things that actually determine it: how many
 * samples, over how long, and how well a line describes them.
 *
 * `high` is deliberately hard to reach. An hour of steady, well-fitted data is
 * the bar, because anything less is an extrapolation of a burst.
 */
export function confidenceFor(samples: number, spanMs: number, rSquared: number): Confidence {
  if (samples >= 20 && spanMs >= 45 * 60_000 && rSquared >= 0.85) return 'high';
  if (samples >= 8 && spanMs >= 20 * 60_000 && rSquared >= 0.6) return 'medium';
  if (samples >= MIN_SAMPLES_FOR_RATE && spanMs >= MIN_SPAN_MS) return 'low';
  return 'none';
}

export function leastSquares(samples: BurnSample[]): { slope: number; rSquared: number } {
  const n = samples.length;
  // Times are shifted to the first sample before fitting. Epoch milliseconds
  // squared overflows the precise range of a double, and the resulting slope is
  // quietly wrong rather than obviously wrong.
  const t0 = Math.min(...samples.map((s) => s.at));
  const xs = samples.map((s) => s.at - t0);
  const ys = samples.map((s) => s.headroomPct);
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;

  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = (xs[i] as number) - meanX;
    sxy += dx * ((ys[i] as number) - meanY);
    sxx += dx * dx;
  }
  if (sxx === 0) return { slope: 0, rSquared: 0 };
  const slope = sxy / sxx;
  const intercept = meanY - slope * meanX;

  let ssRes = 0;
  let ssTot = 0;
  for (let i = 0; i < n; i += 1) {
    const predicted = intercept + slope * (xs[i] as number);
    ssRes += ((ys[i] as number) - predicted) ** 2;
    ssTot += ((ys[i] as number) - meanY) ** 2;
  }
  // A perfectly flat series has no variation to explain. R²=1 there is the
  // conventional answer and it is also the useful one: a flat line IS the
  // series exactly.
  const rSquared = ssTot === 0 ? 1 : Math.max(0, Math.min(1, 1 - ssRes / ssTot));
  return { slope, rSquared };
}

export interface Prediction {
  /** ISO time headroom is projected to reach `targetPct`, or null. */
  at: string | null;
  /** Milliseconds until then, or null. */
  inMs: number | null;
  confidence: Confidence;
  /** Always populated, and says plainly when there is nothing to say. */
  detail: string;
}

/**
 * When the account is projected to reach `targetPct` headroom.
 *
 * Every not-knowing case returns `at: null` with a `detail` that names the
 * reason. There is no branch in this function that produces a time from an
 * unknown rate.
 */
export function predictThreshold(
  currentHeadroomPct: number,
  rate: BurnRate,
  targetPct: number,
  nowMs = Date.now(),
  /**
   * The window this projection is about.
   *
   * Carried purely so the sentences below can name it. A projection is a claim
   * about one window, and "reaches 5% in two hours" is a different statement
   * depending on whether the window refills this afternoon or on Sunday.
   */
  window = 'the binding window',
): Prediction {
  if (rate.pctPerHour === null) {
    return { at: null, inMs: null, confidence: 'none', detail: rate.basis };
  }
  if (currentHeadroomPct <= targetPct) {
    return {
      at: new Date(nowMs).toISOString(),
      inMs: 0,
      confidence: rate.confidence,
      detail: `${window} is already at or below ${targetPct}% headroom`,
    };
  }
  if (rate.pctPerHour <= 0) {
    return {
      at: null,
      inMs: null,
      confidence: rate.confidence,
      detail: `${window} is not falling at the moment, so there is nothing to project`,
    };
  }
  const hours = (currentHeadroomPct - targetPct) / rate.pctPerHour;
  const inMs = hours * 3_600_000;
  return {
    at: new Date(nowMs + inMs).toISOString(),
    inMs,
    confidence: rate.confidence,
    detail:
      `at ${rate.pctPerHour.toFixed(1)} points/hour, ${formatDuration(inMs)} to ` +
      `${targetPct}% headroom on ${window} ` +
      `(${rate.confidence} confidence: ${rate.basis})`,
  };
}

/**
 * Whether the running work is likely to finish before the threshold is hit.
 *
 * Returns null — meaning "cannot say" — far more often than it returns a
 * boolean, because that is the truth. It needs both a usable burn rate and an
 * estimate of what the work needs, and either being absent makes the question
 * unanswerable rather than defaulting to yes.
 */
export function willFinishFirst(
  prediction: Prediction,
  neededPct: number | null,
  currentHeadroomPct: number,
  window = 'the binding window',
): { answer: boolean | null; detail: string } {
  if (neededPct === null) {
    return {
      answer: null,
      detail: 'cannot say: no estimate of what the running work needs',
    };
  }
  if (prediction.inMs === null) {
    return { answer: null, detail: `cannot say: ${prediction.detail}` };
  }
  const answer = currentHeadroomPct >= neededPct;
  // Headroom, said as headroom and with its window named. This one figure is
  // deliberately not inverted: it is being compared against an ESTIMATE of what
  // the work needs, which is also expressed as headroom, and flipping one side
  // of a comparison is how a screen stops meaning anything.
  const have = `${currentHeadroomPct.toFixed(0)}% headroom on ${window}`;
  return {
    answer,
    detail: answer
      ? `${have} vs an estimated ${neededPct.toFixed(0)}% needed`
      : `${have} is under the estimated ${neededPct.toFixed(0)}% needed`,
  };
}

export function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return 'under a minute';
  if (minutes < 90) return `${minutes}m`;
  const hours = ms / 3_600_000;
  if (hours < 48) return `${hours.toFixed(1)}h`;
  return `${Math.round(hours / 24)}d`;
}
