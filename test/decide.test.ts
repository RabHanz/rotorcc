/**
 * The rotation policy is the part that must not misfire, so it gets the most
 * tests: every threshold crossing, every latch, the hysteresis band, the
 * cooldown, and the refusal to rotate when there is nowhere to go.
 */
import { describe, expect, it } from 'vitest';

import { decide, decideHardKill, emptyState, levelFor, pickTarget } from '../src/core/decide.js';
import type { RotorState } from '../src/core/decide.js';
import type { AccountReading, UsageReading } from '../src/core/usage.js';
import { testConfig } from './helpers.js';

function account(
  number: number,
  headroomPct: number,
  overrides: Partial<AccountReading> = {},
): AccountReading {
  return {
    number,
    email: `a${number}@example.com`,
    active: false,
    headroomPct,
    bindingWindow: '5h',
    bindingResetsAt: '2026-08-18T00:00:00Z',
    windows: [{ name: '5h', headroomPct, resetsAt: '2026-08-18T00:00:00Z' }],
    stale: false,
    ...overrides,
  };
}

function reading(
  activeHeadroom: number,
  others: number[] = [80, 90],
  observedAt = '2026-08-17T12:00:00Z',
  activeOverrides: Partial<AccountReading> = {},
): UsageReading {
  return {
    observedAt,
    activeAccountNumber: 1,
    accounts: [
      account(1, activeHeadroom, { active: true, ...activeOverrides }),
      ...others.map((h, i) => account(i + 2, h)),
    ],
    source: 'list',
  };
}

const config = testConfig();

describe('levelFor', () => {
  it('maps headroom onto the four levels at the configured boundaries', () => {
    const t = config.thresholds; // warn 15, soft 10, rotate 5
    expect(levelFor(100, t)).toBe('ok');
    expect(levelFor(15.1, t)).toBe('ok');
    expect(levelFor(15, t)).toBe('warn');
    expect(levelFor(10.1, t)).toBe('warn');
    expect(levelFor(10, t)).toBe('soft');
    expect(levelFor(5.1, t)).toBe('soft');
    expect(levelFor(5, t)).toBe('rotate');
    expect(levelFor(0, t)).toBe('rotate');
  });
});

describe('decide — thresholds', () => {
  it('does nothing while there is headroom', () => {
    const decision = decide(reading(60), config, emptyState());
    expect(decision.level).toBe('ok');
    expect(decision.actions).toEqual([]);
  });

  it('warns once at the warn threshold', () => {
    const first = decide(reading(14), config, emptyState());
    expect(first.level).toBe('warn');
    expect(first.actions).toEqual([{ kind: 'log-warning' }]);

    const second = decide(reading(13), config, first.nextState);
    expect(second.actions).toEqual([]);
  });

  it('checkpoints at the soft threshold, and warns in the same tick if it had not yet', () => {
    const decision = decide(reading(9), config, emptyState());
    expect(decision.level).toBe('soft');
    expect(decision.actions).toEqual([{ kind: 'log-warning' }, { kind: 'soft-checkpoint' }]);
  });

  it('does not repeat the soft checkpoint while headroom keeps falling', () => {
    const first = decide(reading(9), config, emptyState());
    const second = decide(reading(7), config, first.nextState);
    expect(second.actions).toEqual([]);
  });

  it('rotates at the rotate threshold and picks the account with the most left', () => {
    const decision = decide(reading(4, [30, 90, 55]), config, emptyState());
    expect(decision.level).toBe('rotate');
    expect(decision.actions).toContainEqual({ kind: 'rotate', targetAccount: 3 });
  });

  it('does not also emit a separate checkpoint when it is rotating', () => {
    // The rotation checkpoints as its first step. Emitting both would commit,
    // push, and then commit and push again a second later.
    const decision = decide(reading(2), config, emptyState());
    const kinds = decision.actions.map((a) => a.kind);
    expect(kinds).toContain('log-warning');
    expect(kinds).toContain('rotate');
    expect(kinds).not.toContain('soft-checkpoint');
  });

  it('still arms the soft latch while rotating, so a partial recovery does not re-fire it', () => {
    const rotating = decide(reading(2), config, emptyState());
    expect(rotating.nextState.latches.soft).toBeDefined();
    const drifted = decide(reading(8), config, rotating.nextState);
    expect(drifted.actions).toEqual([]);
  });
});

describe('decide — latches and hysteresis', () => {
  it('holds the latch while headroom stays inside the hysteresis band', () => {
    const first = decide(reading(9), config, emptyState());
    // soft is 10 and hysteresis is 5, so anything at or below 15 keeps the latch
    const second = decide(reading(14), config, first.nextState);
    expect(second.actions).toEqual([]);
    expect(second.nextState.latches.soft).toBeDefined();
  });

  it('re-arms once headroom climbs clear of threshold + hysteresis', () => {
    const first = decide(reading(9), config, emptyState());
    const recovered = decide(reading(40), config, first.nextState);
    expect(recovered.nextState.latches.soft).toBeUndefined();

    const again = decide(reading(9), config, recovered.nextState);
    expect(again.actions).toContainEqual({ kind: 'soft-checkpoint' });
  });

  it('re-arms when the quota window rolls over, even at the same headroom', () => {
    const first = decide(reading(9), config, emptyState());
    const nextWindow: UsageReading = {
      ...reading(9),
      accounts: [
        account(1, 9, { active: true, bindingResetsAt: '2026-08-19T00:00:00Z' }),
        account(2, 80),
      ],
    };
    const second = decide(nextWindow, config, first.nextState);
    expect(second.actions).toContainEqual({ kind: 'soft-checkpoint' });
  });

  it('drops every latch when the active account changes', () => {
    const first = decide(reading(9), config, emptyState());
    const afterSwitch: UsageReading = {
      observedAt: '2026-08-17T13:00:00Z',
      activeAccountNumber: 2,
      accounts: [account(1, 9), account(2, 9, { active: true })],
      source: 'list',
    };
    const second = decide(afterSwitch, config, first.nextState);
    expect(second.actions).toContainEqual({ kind: 'soft-checkpoint' });
    expect(second.nextState.latchedAccount).toBe(2);
  });
});

describe('decide — cooldown and thrash refusal', () => {
  it('refuses a second rotation inside the cooldown, and checkpoints instead', () => {
    const state: RotorState = {
      ...emptyState(),
      lastRotationAt: '2026-08-17T11:55:00Z', // five minutes before the reading
    };
    const decision = decide(reading(3), config, state);
    expect(decision.actions.some((a) => a.kind === 'rotate')).toBe(false);
    expect(decision.actions).toContainEqual({ kind: 'soft-checkpoint' });
    expect(decision.actions.find((a) => a.kind === 'blocked')?.kind).toBe('blocked');
  });

  it('allows the rotation once the cooldown has passed', () => {
    const state: RotorState = { ...emptyState(), lastRotationAt: '2026-08-17T11:00:00Z' };
    const decision = decide(reading(3), config, state);
    expect(decision.actions).toContainEqual({ kind: 'rotate', targetAccount: 3 });
  });

  it('refuses to rotate when no account has enough headroom, and says so', () => {
    const decision = decide(reading(3, [4, 2]), config, emptyState());
    expect(decision.actions.some((a) => a.kind === 'rotate')).toBe(false);
    const blocked = decision.actions.find((a) => a.kind === 'blocked');
    expect(blocked).toBeDefined();
    expect(blocked && 'reason' in blocked ? blocked.reason : '').toContain('headroom');
    // The work still gets saved.
    expect(decision.actions).toContainEqual({ kind: 'soft-checkpoint' });
  });

  it('does not rotate onto an account whose usage could not be read', () => {
    const stale: UsageReading = {
      observedAt: '2026-08-17T12:00:00Z',
      activeAccountNumber: 1,
      accounts: [account(1, 3, { active: true }), account(2, 99, { stale: true })],
      source: 'list',
    };
    expect(pickTarget(stale, config)).toBeNull();
  });

  it('handles a usage source that reports no active account', () => {
    const orphan: UsageReading = {
      observedAt: '2026-08-17T12:00:00Z',
      activeAccountNumber: null,
      accounts: [],
      source: 'list',
    };
    const decision = decide(orphan, config, emptyState());
    expect(decision.actions[0]?.kind).toBe('blocked');
  });
});

describe('decideHardKill', () => {
  it('rotates regardless of the percentages when the limit was actually hit', () => {
    const decision = decideHardKill(reading(93, [95]), config, emptyState(), 'limit-signature');
    expect(decision.level).toBe('rotate');
    expect(decision.actions).toContainEqual({ kind: 'rotate', targetAccount: 2 });
    expect(decision.reason).toContain('limit-signature');
  });

  it('still respects the cooldown, because a repeat is a bug not a retry', () => {
    const state: RotorState = { ...emptyState(), lastRotationAt: '2026-08-17T11:59:00Z' };
    const decision = decideHardKill(reading(93, [95]), config, state, 'dead-process');
    expect(decision.actions.some((a) => a.kind === 'rotate')).toBe(false);
    expect(decision.actions).toContainEqual({ kind: 'soft-checkpoint' });
  });
});
