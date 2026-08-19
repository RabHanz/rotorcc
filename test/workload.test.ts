/**
 * The work-in-flight assessment: rotorcc's actual reason for existing.
 *
 * A plain account switcher moves you to whichever account has the most quota
 * left. These tests pin the two extra questions rotorcc asks first — is
 * anything at risk, and is the target big enough to finish — and in particular
 * that it REFUSES rather than doing something confident and wrong.
 */
import { describe, expect, it } from 'vitest';

import {
  type UnsavedTree,
  type WorkloadSnapshot,
  assessRotationSafety,
  estimateHeadroomNeeded,
} from '../src/core/workload.js';

function tree(overrides: Partial<UnsavedTree> = {}): UnsavedTree {
  return {
    project: '/proj',
    tree: '/proj/.claude/worktrees/agent-1',
    branch: 'work/agent-1',
    unpushedCommits: 3,
    dirtyFiles: 0,
    protectedBranch: false,
    midOperation: null,
    noRemote: false,
    ...overrides,
  };
}

function workload(unsaved: UnsavedTree[], activeSessions = 1): WorkloadSnapshot {
  const needsHuman = unsaved.filter(
    (t) => t.protectedBranch || t.midOperation !== null || t.noRemote,
  );
  const sessions = Array.from({ length: activeSessions }, (_, i) => ({
    sessionId: `s${i}`,
    project: '/proj',
    idleSeconds: 10,
    bytes: 1000,
  }));
  return {
    unsaved,
    savable: unsaved.filter((t) => !needsHuman.includes(t)),
    needsHuman,
    sessions,
    activeSessions: sessions,
    takenAt: '2026-08-19T12:00:00Z',
  };
}

describe('assessRotationSafety', () => {
  it('is safe when nothing is unsaved', () => {
    expect(assessRotationSafety(workload([])).verdict).toBe('safe');
  });

  it('says save-first for work rotorcc can save itself', () => {
    const safety = assessRotationSafety(workload([tree()]));
    expect(safety.verdict).toBe('save-first');
  });

  it('REFUSES for a protected branch, which rotorcc will never commit to', () => {
    const safety = assessRotationSafety(
      workload([tree({ branch: 'main', protectedBranch: true })]),
    );
    expect(safety.verdict).toBe('refuse');
    expect(safety.reason).toContain('protected branch');
  });

  it('REFUSES mid-rebase, where `git add -A` would commit conflict markers', () => {
    const safety = assessRotationSafety(workload([tree({ midOperation: 'rebase' })]));
    expect(safety.verdict).toBe('refuse');
    expect(safety.reason).toContain('rebase');
  });

  it('REFUSES a branch with no remote, which has nowhere to be pushed', () => {
    const safety = assessRotationSafety(workload([tree({ noRemote: true })]));
    expect(safety.verdict).toBe('refuse');
    expect(safety.reason).toContain('no remote');
  });

  it('escalates save-first to refuse once a checkpoint has already run', () => {
    // Anything still unsaved after a checkpoint is by definition something
    // rotorcc could not save, whatever the reason.
    const safety = assessRotationSafety(workload([tree()]), { alreadyCheckpointed: true });
    expect(safety.verdict).toBe('refuse');
    expect(safety.reason).toContain('still unsaved after a checkpoint');
  });

  it('names the trees that caused the refusal, not just the count', () => {
    const safety = assessRotationSafety(
      workload([tree({ protectedBranch: true, branch: 'main' })]),
    );
    expect(safety.verdict === 'refuse' && safety.trees[0]?.branch).toBe('main');
  });

  it('counts an uninspectable tree as at risk rather than as empty', () => {
    // A project rotorcc could not read is not a project with nothing in it.
    const safety = assessRotationSafety(
      workload([tree({ branch: '(unknown)', unpushedCommits: null })]),
    );
    expect(safety.verdict).not.toBe('safe');
  });
});

describe('estimateHeadroomNeeded', () => {
  it('returns null with no burn history and says so, rather than guessing', () => {
    const requirement = estimateHeadroomNeeded(workload([]), null);
    expect(requirement.estimatedPct).toBeNull();
    expect(requirement.confidence).toBe('none');
    expect(requirement.basis).toContain('not yet observed enough headroom history');
  });

  it('reports nothing running when no session has written recently', () => {
    const idle = { ...workload([], 0), activeSessions: [] };
    const requirement = estimateHeadroomNeeded(idle, 20);
    expect(requirement.confidence).toBe('none');
    expect(requirement.basis).toContain('nothing appears to be running');
  });

  it('projects the observed burn over the horizon', () => {
    const requirement = estimateHeadroomNeeded(workload([]), 24, { horizonHours: 1 });
    expect(requirement.estimatedPct).toBeCloseTo(24, 5);
  });

  it('never claims better than medium confidence for a linear extrapolation', () => {
    // The underlying process is bursty. Dressing a straight line through it up
    // as "high confidence" is the sort of confident report this tool exists
    // not to produce.
    const requirement = estimateHeadroomNeeded(workload([]), 40);
    expect(requirement.confidence).toBe('medium');
  });

  it('never returns less than the configured floor', () => {
    const requirement = estimateHeadroomNeeded(workload([]), 1, { minimumPct: 20 });
    expect(requirement.estimatedPct).toBe(20);
  });
});
