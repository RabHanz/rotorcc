/**
 * The `rotorcc daemon --once` exit-code contract.
 *
 * These tests are the contract. A cron line branches on these numbers, so a
 * change that moves one is a breaking change and has to break a test here
 * first — not be discovered by an operator whose alerting went quiet.
 *
 * The one that matters most is the last group: a tick that decided nothing
 * because every account is spent must NOT report "nothing to do". That is the
 * exact shape of every production defect this project has had.
 */
import { describe, expect, it } from 'vitest';

import {
  EXIT_ACTED,
  EXIT_BLOCKED,
  EXIT_ERROR,
  EXIT_NOTHING_TO_DO,
  type TickResult,
  exitCodeFor,
} from '../src/core/daemon.js';
import { type Action, type Decision, emptyState } from '../src/core/decide.js';

function decision(actions: Action[]): Decision {
  return {
    level: 'ok',
    headroomPct: 50,
    bindingWindow: '7d',
    activeAccount: 1,
    actions,
    reason: 'test',
    nextState: emptyState(),
  };
}

function result(overrides: Partial<TickResult> = {}): TickResult {
  return {
    ok: true,
    decision: null,
    actionsTaken: [],
    hardKill: null,
    detail: 'test',
    ...overrides,
  };
}

describe('daemon --once exit codes', () => {
  it('exits 0 when there was nothing to do', () => {
    expect(exitCodeFor(result({ decision: decision([]) }))).toBe(EXIT_NOTHING_TO_DO);
    expect(EXIT_NOTHING_TO_DO).toBe(0);
  });

  it('exits 1 when it acted', () => {
    expect(exitCodeFor(result({ actionsTaken: ['soft-checkpoint'] }))).toBe(EXIT_ACTED);
    expect(exitCodeFor(result({ actionsTaken: ['handover-queued', 'soft-checkpoint'] }))).toBe(
      EXIT_ACTED,
    );
    expect(exitCodeFor(result({ actionsTaken: ['switched:2', 'manifest'] }))).toBe(EXIT_ACTED);
    expect(exitCodeFor(result({ actionsTaken: ['log-warning'] }))).toBe(EXIT_ACTED);
    expect(EXIT_ACTED).toBe(1);
  });

  it('exits 2 when it wanted to act and could not', () => {
    expect(
      exitCodeFor(result({ actionsTaken: ['blocked: no account with enough headroom'] })),
    ).toBe(EXIT_BLOCKED);
    expect(EXIT_BLOCKED).toBe(2);
  });

  it('exits 2 when another operation held the lock, never 0', () => {
    // A skipped tick did not look at anything. Reporting "nothing to do" would
    // be a claim about headroom that this tick is in no position to make.
    const skipped = result({
      skippedForLock: true,
      detail: 'another rotorcc operation holds the lock; skipping this tick',
    });
    expect(exitCodeFor(skipped)).toBe(EXIT_BLOCKED);
    expect(exitCodeFor(skipped)).not.toBe(EXIT_NOTHING_TO_DO);
  });

  it('exits 3 when the tick could not complete', () => {
    expect(exitCodeFor(result({ ok: false, detail: 'usage unreadable' }))).toBe(EXIT_ERROR);
    expect(EXIT_ERROR).toBe(3);
  });

  it('exits 3 when an action it started failed, even though the tick finished', () => {
    // `tick()` returns ok:true here — the tick ran. But the switch it attempted
    // did not happen, and a cron job that reads that as a healthy rotation has
    // been told the opposite of the truth.
    expect(exitCodeFor(result({ actionsTaken: ['manifest', 'switch-failed'] }))).toBe(EXIT_ERROR);
    expect(exitCodeFor(result({ actionsTaken: ['successor:failed'] }))).toBe(EXIT_ERROR);
  });

  it('prefers blocked over acted: a refusal is the part a human decides about', () => {
    const refused = result({
      actionsTaken: ['blocked: work-aware refusal — unsaved work', 'soft-checkpoint'],
    });
    expect(exitCodeFor(refused)).toBe(EXIT_BLOCKED);
  });

  it('prefers error over blocked', () => {
    const both = result({ actionsTaken: ['blocked: something', 'switch-failed'] });
    expect(exitCodeFor(both)).toBe(EXIT_ERROR);
  });

  it('reports a latched all-exhausted stop as blocked, not as nothing to do', () => {
    // The stop notice is given once per window; every tick after that takes no
    // action at all. `actionsTaken` is empty — but every account is still spent,
    // and 0 would tell a monitor the machine is healthy.
    const latched = result({
      actionsTaken: [],
      decision: decision([{ kind: 'blocked', reason: 'every account is out of weekly quota' }]),
      detail: 'STOPPED — every account is out of weekly quota (notice already given)',
    });
    expect(exitCodeFor(latched)).toBe(EXIT_BLOCKED);
  });

  it('reports an unmeasurable active account as blocked', () => {
    const blind = result({
      decision: decision([
        { kind: 'blocked', reason: 'no active account reported by the usage source' },
      ]),
    });
    expect(exitCodeFor(blind)).toBe(EXIT_BLOCKED);
  });

  it('treats a dry run that would have acted as acted, with nothing written', () => {
    // The point of `--dry-run` in cron is to ask the question without answering
    // it. The code reports the answer; the `dry-run-` prefixes report that
    // nothing happened.
    const dry = result({
      actionsTaken: ['dry-run-manifest', 'dry-run-flag-suppressed', 'dry-run-switch:2'],
    });
    expect(exitCodeFor(dry)).toBe(EXIT_ACTED);
  });

  it('never returns anything outside 0..3', () => {
    const samples: TickResult[] = [
      result(),
      result({ ok: false }),
      result({ skippedForLock: true }),
      result({ actionsTaken: ['anything at all'] }),
      result({ decision: decision([{ kind: 'rotate', targetAccount: 2 }]) }),
    ];
    for (const sample of samples) {
      expect([0, 1, 2, 3]).toContain(exitCodeFor(sample));
    }
  });
});
