/**
 * The whole rotation policy, as one pure function.
 *
 * Nothing here reads a clock, a file or a subprocess: `decide` takes a usage
 * reading, the config and the last known state, and returns what should happen
 * plus the state to persist. That is deliberate. Rotation is the part of this
 * tool that must never misfire, and a pure function is the part that can be
 * exhaustively tested.
 *
 * Three guards stop the two ways an automatic switcher goes wrong:
 *
 *   latch      Each level fires once per window. Without it, a daemon at 4.9%
 *              headroom writes a manifest every 60 seconds for four hours.
 *   hysteresis A latch only clears once headroom climbs `hysteresisPct` ABOVE
 *              the threshold, so a reading that flickers across the line does
 *              not re-arm the alarm.
 *   cooldown   No second rotation within `cooldownSeconds`, whatever the
 *              numbers say. A switch that did not take needs a human, not a
 *              retry loop.
 *
 * And one refusal: if no other account has `minTargetHeadroomPct` left, rotorcc
 * does not rotate at all. Hopping between three exhausted accounts burns the
 * session and loses the work; stopping loudly does not.
 */
import type { Config } from '../config/schema.js';
import { type AccountReading, type UsageReading, activeAccount } from './usage.js';

export type Level = 'ok' | 'warn' | 'soft' | 'rotate';

export const LEVELS: Level[] = ['ok', 'warn', 'soft', 'rotate'];

export interface LatchState {
  /** ISO time the latch was armed. */
  at: string;
  /**
   * Identifies the quota window the latch belongs to: the binding window's
   * reset time when the source reports one, otherwise its name. When this
   * changes, the window rolled over and the latch is stale.
   */
  windowKey: string;
  /** Headroom at the moment it fired, for the log and the status screen. */
  headroomPct: number;
}

export interface RotorState {
  version: 1;
  /** Per-level latches for the account they were armed on. */
  latches: Partial<Record<Exclude<Level, 'ok'>, LatchState>>;
  /** Which account the latches belong to; a switch clears them. */
  latchedAccount: number | null;
  lastRotationAt: string | null;
  lastRotationTarget: number | null;
  lastSnapshotAt: string | null;
  lastManifestPath: string | null;
  lastLevel: Level;
  /** Sessions rotorcc has seen end cleanly, newest first. */
  cleanExits: Array<{ sessionId: string; at: string }>;
  /** Sessions rotorcc last saw alive, for crash detection on next start. */
  openSessions: Array<{ sessionId: string; transcriptPath: string; cwd: string; at: string }>;
}

export function emptyState(): RotorState {
  return {
    version: 1,
    latches: {},
    latchedAccount: null,
    lastRotationAt: null,
    lastRotationTarget: null,
    lastSnapshotAt: null,
    lastManifestPath: null,
    lastLevel: 'ok',
    cleanExits: [],
    openSessions: [],
  };
}

export type Action =
  | { kind: 'log-warning' }
  | { kind: 'soft-checkpoint' }
  | { kind: 'rotate'; targetAccount: number }
  | { kind: 'blocked'; reason: string };

export interface Decision {
  level: Level;
  /** Headroom of the active account's binding window. */
  headroomPct: number;
  bindingWindow: string;
  activeAccount: number | null;
  actions: Action[];
  /** One line, written to the log and shown by `rotorcc status`. */
  reason: string;
  nextState: RotorState;
}

function windowKey(account: AccountReading): string {
  return account.bindingResetsAt ?? `${account.bindingWindow}@unknown`;
}

export function levelFor(
  headroomPct: number,
  thresholds: { warnPct: number; softPct: number; rotatePct: number },
): Level {
  if (headroomPct <= thresholds.rotatePct) return 'rotate';
  if (headroomPct <= thresholds.softPct) return 'soft';
  if (headroomPct <= thresholds.warnPct) return 'warn';
  return 'ok';
}

function thresholdFor(level: Exclude<Level, 'ok'>, config: Config): number {
  if (level === 'warn') return config.thresholds.warnPct;
  if (level === 'soft') return config.thresholds.softPct;
  return config.thresholds.rotatePct;
}

/**
 * A latch is live when it was armed for the current quota window and headroom
 * has not recovered past threshold + hysteresis. (The caller has already
 * discarded latches belonging to a different account.)
 */
function latchIsLive(
  latch: LatchState | undefined,
  level: Exclude<Level, 'ok'>,
  account: AccountReading,
  config: Config,
): boolean {
  if (latch === undefined) return false;
  if (latch.windowKey !== windowKey(account)) return false;
  const clearAt = thresholdFor(level, config) + config.hysteresisPct;
  return account.headroomPct <= clearAt;
}

/** The account with the most headroom that is not the active one. */
export function pickTarget(reading: UsageReading, config: Config): AccountReading | null {
  const active = activeAccount(reading);
  const candidates = reading.accounts
    .filter((a) => a.number !== active?.number)
    .filter((a) => !a.stale)
    .filter((a) => a.headroomPct >= config.minTargetHeadroomPct)
    .sort((a, b) => b.headroomPct - a.headroomPct);
  return candidates[0] ?? null;
}

function secondsBetween(fromIso: string, toIso: string): number {
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (Number.isNaN(from) || Number.isNaN(to)) return Number.POSITIVE_INFINITY;
  return (to - from) / 1000;
}

export function decide(reading: UsageReading, config: Config, state: RotorState): Decision {
  const active = activeAccount(reading);
  const now = reading.observedAt;

  if (active === null) {
    return {
      level: 'ok',
      headroomPct: 100,
      bindingWindow: 'unknown',
      activeAccount: null,
      actions: [{ kind: 'blocked', reason: 'no active account reported by the usage source' }],
      reason: 'usage source reported no active account; nothing to evaluate',
      nextState: { ...state, lastLevel: 'ok' },
    };
  }

  // A switch since the last tick invalidates every latch: the new account has
  // its own windows and its own reset times.
  const latchesValid = state.latchedAccount === null || state.latchedAccount === active.number;
  const latches = latchesValid ? { ...state.latches } : {};

  // Clear latches whose window has rolled over or whose headroom recovered
  // past threshold + hysteresis.
  for (const which of ['warn', 'soft', 'rotate'] as const) {
    if (latches[which] !== undefined && !latchIsLive(latches[which], which, active, config)) {
      delete latches[which];
    }
  }

  const level = levelFor(active.headroomPct, config.thresholds);
  const actions: Action[] = [];
  const reasons: string[] = [];

  /** Arm a latch if it is not already live. Returns whether this tick owns it. */
  const arm = (which: Exclude<Level, 'ok'>): boolean => {
    if (latches[which] !== undefined) {
      reasons.push(`${which} already latched for this window`);
      return false;
    }
    latches[which] = { at: now, windowKey: windowKey(active), headroomPct: active.headroomPct };
    return true;
  };

  let target: AccountReading | null = null;

  // Levels are cumulative: crossing `rotate` means `soft` and `warn` are also
  // true. Each still fires at most once, so a session that goes straight from
  // 40% to 3% between two ticks still gets its warning and its checkpoint.
  if (level === 'warn' || level === 'soft' || level === 'rotate') {
    if (arm('warn')) {
      actions.push({ kind: 'log-warning' });
      reasons.push(`headroom ${active.headroomPct.toFixed(1)}% on ${active.bindingWindow}`);
    }
  }

  // The soft latch is armed at rotate level too, so that headroom drifting back
  // up to 8% later does not produce a second checkpoint. The ACTION is only
  // emitted below rotate level: a rotation checkpoints as its first step, and
  // emitting both would commit, push and then commit and push again.
  if (level === 'soft' || level === 'rotate') {
    if (arm('soft') && level === 'soft') {
      actions.push({ kind: 'soft-checkpoint' });
      reasons.push('soft checkpoint requested');
    }
  }

  if (level === 'rotate' && arm('rotate')) {
    const sinceLast =
      state.lastRotationAt === null
        ? Number.POSITIVE_INFINITY
        : secondsBetween(state.lastRotationAt, now);
    if (sinceLast < config.cooldownSeconds) {
      actions.push({
        kind: 'blocked',
        reason: `cooldown: last rotation was ${Math.round(sinceLast)}s ago, cooldown is ${config.cooldownSeconds}s`,
      });
      reasons.push('rotation suppressed by cooldown');
    } else {
      target = pickTarget(reading, config);
      if (target === null) {
        actions.push({
          kind: 'blocked',
          reason: `no account has ${config.minTargetHeadroomPct}% headroom to rotate onto`,
        });
        reasons.push('no viable target; refusing to thrash');
      } else {
        actions.push({ kind: 'rotate', targetAccount: target.number });
        reasons.push(
          `rotating to account ${target.number} (${Math.round(target.headroomPct)}% headroom)`,
        );
      }
    }
    // A rotation checkpoints on its way out. A rotation that was refused does
    // not, and that is exactly when the work most needs saving.
    if (target === null && !actions.some((a) => a.kind === 'soft-checkpoint')) {
      actions.push({ kind: 'soft-checkpoint' });
    }
  }

  const reason =
    reasons.length > 0
      ? reasons.join('; ')
      : `headroom ${active.headroomPct.toFixed(1)}% on ${active.bindingWindow}; nothing to do`;

  const nextState: RotorState = {
    ...state,
    latches,
    latchedAccount: active.number,
    lastLevel: level,
    ...(target !== null ? { lastRotationAt: now, lastRotationTarget: target.number } : {}),
  };

  return {
    level,
    headroomPct: active.headroomPct,
    bindingWindow: active.bindingWindow,
    activeAccount: active.number,
    actions,
    reason,
    nextState,
  };
}

/**
 * A hard limit error or a dead process overrides the percentages entirely: the
 * numbers said there was room and the session died anyway, so the reading was
 * wrong or stale. Cooldown still applies — a rotation that just happened and
 * did not take is a bug to look at, not a thing to repeat.
 */
export function decideHardKill(
  reading: UsageReading,
  config: Config,
  state: RotorState,
  trigger: 'limit-signature' | 'dead-process',
): Decision {
  const active = activeAccount(reading);
  const now = reading.observedAt;
  const actions: Action[] = [];
  const sinceLast =
    state.lastRotationAt === null
      ? Number.POSITIVE_INFINITY
      : secondsBetween(state.lastRotationAt, now);

  let target: AccountReading | null = null;
  if (sinceLast < config.cooldownSeconds) {
    actions.push({
      kind: 'blocked',
      reason: `cooldown: last rotation was ${Math.round(sinceLast)}s ago`,
    });
    actions.push({ kind: 'soft-checkpoint' });
  } else {
    target = pickTarget(reading, config);
    if (target === null) {
      actions.push({ kind: 'blocked', reason: 'no account with enough headroom to rotate onto' });
      actions.push({ kind: 'soft-checkpoint' });
    } else {
      actions.push({ kind: 'rotate', targetAccount: target.number });
    }
  }

  return {
    level: 'rotate',
    headroomPct: active?.headroomPct ?? 0,
    bindingWindow: active?.bindingWindow ?? 'unknown',
    activeAccount: active?.number ?? null,
    actions,
    reason: `hard kill detected (${trigger})`,
    nextState: {
      ...state,
      latches: {
        ...state.latches,
        rotate: {
          at: now,
          windowKey: active?.bindingResetsAt ?? `${active?.bindingWindow ?? 'unknown'}@hardkill`,
          headroomPct: active?.headroomPct ?? 0,
        },
      },
      latchedAccount: active?.number ?? state.latchedAccount,
      lastLevel: 'rotate',
      ...(target !== null ? { lastRotationAt: now, lastRotationTarget: target.number } : {}),
    },
  };
}
