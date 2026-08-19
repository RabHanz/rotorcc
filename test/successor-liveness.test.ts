/**
 * A successor must NEVER launch beside a live predecessor.
 *
 * 2026-08-19: rotorcc launched a duplicate `claude --continue` onto a session
 * that was alive and working. Two causes:
 *   1. `detectHardKill` returned "dead" from a transcript SIGNATURE alone. The
 *      tail carried "You've hit your session limit" — but that was six SUBAGENTS
 *      dying, recorded as their task-notification results, not the operator.
 *   2. `launchSuccessor` launched even though the tick already knew the
 *      predecessor was alive (it logged `predecessor:left-running`).
 * The result was two operators on one worktree — corruption, not resumption.
 *
 * The invariant, pinned here: "predecessor alive" and "launch a successor" are
 * mutually exclusive, enforced at the moment of launch regardless of any
 * upstream decision.
 */
import { describe, expect, it } from 'vitest';
import { launchSuccessor } from '../src/core/successor.js';
import type { Config } from '../src/config/schema.js';

function silentLogger() {
  return { info() {}, warn() {}, error() {}, debug() {} } as never;
}

// Minimal config: only the fields launchSuccessor reads before the liveness gate.
const config = { successor: { launcher: 'tmux' } } as unknown as Config;

describe('launchSuccessor — liveness gate', () => {
  it('REFUSES when the predecessor is still alive', async () => {
    const result = await launchSuccessor({
      config,
      logger: silentLogger(),
      cwd: '/tmp/x',
      prompt: 'resume',
      dryRun: false,
      predecessorAlive: true,
    });
    expect(result.ok).toBe(false);
    expect(result.handle).toBeNull();
    expect(result.warnings).toContain('successor-refused-predecessor-alive');
    expect(result.detail).toMatch(/still alive|two operators/i);
  });

  it('refuses BEFORE choosing a launcher — the gate is unconditional', async () => {
    // Even with an unknown launcher, a live predecessor must short-circuit to a
    // refusal, never fall through to a launch attempt.
    const weird = { successor: { launcher: 'screen' } } as unknown as Config;
    const result = await launchSuccessor({
      config: weird,
      logger: silentLogger(),
      cwd: '/tmp/x',
      prompt: 'resume',
      dryRun: false,
      predecessorAlive: true,
    });
    expect(result.ok).toBe(false);
    expect(result.warnings).toContain('successor-refused-predecessor-alive');
  });
});
