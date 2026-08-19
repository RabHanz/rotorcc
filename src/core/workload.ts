/**
 * What is actually in flight on this machine, and what it would cost to lose.
 *
 * This is the thing rotorcc knows that a pure account switcher cannot. A
 * switcher sees three accounts and picks the one with the most quota left.
 * rotorcc sees three accounts, forty-eight worktrees, thirteen of them holding
 * commits that exist nowhere else, and a session that has been writing steadily
 * for six hours — and it can refuse.
 *
 * Two questions get answered here, and they are different questions:
 *
 *   1. **Is it safe to rotate right now?** Unsaved work makes it not safe. A
 *      rotation ends a session; whatever was only in that session's working
 *      trees and only on this disk is at risk the moment it does. The answer is
 *      "save it first", not "rotate anyway and hope".
 *
 *   2. **Is the target big enough to finish?** A target with 8% headroom is the
 *      best available and still useless if the work in flight needs twenty. A
 *      switcher that picks by headroom alone will happily rotate onto an
 *      account that dies in ten minutes, which costs a second rotation, a
 *      second manifest and a second cold start.
 *
 * Everything here is honest about uncertainty. `estimatedHeadroomNeededPct` is
 * an estimate and is labelled one; when there is no history to estimate from,
 * it is null and callers say "not enough history" rather than inventing a
 * number and defending it.
 */
import type { Config } from '../config/schema.js';
import { type TreeStatus, discoverTrees } from './worktrees.js';
import { allSessions } from './transcripts.js';

export interface UnsavedTree {
  project: string;
  tree: string;
  branch: string;
  /** Commits that exist here and on no remote. Null when there is no upstream. */
  unpushedCommits: number | null;
  dirtyFiles: number;
  protectedBranch: boolean;
  /** A merge/rebase/cherry-pick in progress: rotorcc will not commit over it. */
  midOperation: string | null;
  /** True when there is nowhere to push this even if we wanted to. */
  noRemote: boolean;
}

export interface RunningSession {
  sessionId: string;
  project: string;
  idleSeconds: number;
  /** Transcript size, a rough proxy for how much context is in flight. */
  bytes: number;
}

export interface WorkloadSnapshot {
  /** Every watched tree holding work that is not on a remote. */
  unsaved: UnsavedTree[];
  /** Trees rotorcc could save automatically if asked to. */
  savable: UnsavedTree[];
  /**
   * Trees rotorcc cannot save on its own: protected branches, mid-operation
   * trees, and trees with no remote. These need a human, and a rotation that
   * ignores them loses the work regardless of how many checkpoints ran.
   */
  needsHuman: UnsavedTree[];
  sessions: RunningSession[];
  /** Sessions that have written within the last few minutes. */
  activeSessions: RunningSession[];
  takenAt: string;
}

/** A session is "active" if its transcript grew this recently. */
export const ACTIVE_SESSION_IDLE_SECONDS = 300;

export async function collectWorkload(
  config: Config,
  options: { now?: () => number } = {},
): Promise<WorkloadSnapshot> {
  const now = options.now ?? (() => Date.now());
  const unsaved: UnsavedTree[] = [];

  for (const project of config.projects) {
    let trees: TreeStatus[];
    try {
      trees = await discoverTrees({ git: config.commands.git }, project);
    } catch {
      // A project we cannot inspect is not a project with no work in it. It is
      // recorded as a tree that needs a human, so the refusal errs toward
      // "do not rotate" rather than toward "nothing to lose here".
      unsaved.push({
        project: project.path,
        tree: project.path,
        branch: '(unknown)',
        unpushedCommits: null,
        dirtyFiles: 0,
        protectedBranch: false,
        midOperation: null,
        noRemote: false,
      });
      continue;
    }
    for (const tree of trees) {
      const unpushed = tree.ahead;
      const hasWork = (unpushed ?? 0) > 0 || tree.dirtyFiles > 0 || unpushed === null;
      if (!hasWork) continue;
      unsaved.push({
        project: project.path,
        tree: tree.path,
        branch: tree.branch,
        unpushedCommits: unpushed,
        dirtyFiles: tree.dirtyFiles,
        protectedBranch: tree.protectedBranch,
        midOperation: tree.midOperation,
        noRemote: !tree.hasRemote,
      });
    }
  }

  const needsHuman = unsaved.filter(
    (t) => t.protectedBranch || t.midOperation !== null || t.noRemote,
  );
  const savable = unsaved.filter((t) => !needsHuman.includes(t));

  const sessions: RunningSession[] = allSessions(config).map((s) => ({
    sessionId: s.sessionId,
    project: s.projectPath,
    idleSeconds: Math.max(0, Math.round((now() - s.mtimeMs) / 1000)),
    bytes: s.bytes,
  }));

  return {
    unsaved,
    savable,
    needsHuman,
    sessions,
    activeSessions: sessions.filter((s) => s.idleSeconds <= ACTIVE_SESSION_IDLE_SECONDS),
    takenAt: new Date(now()).toISOString(),
  };
}

export type RotationSafety =
  /** Nothing is at risk; a rotation now loses nothing. */
  | { verdict: 'safe'; reason: string }
  /** Work is unsaved but rotorcc can save it. The caller should, then re-ask. */
  | { verdict: 'save-first'; reason: string; trees: UnsavedTree[] }
  /**
   * Work is unsaved and rotorcc CANNOT save it. Rotating now loses it. This is
   * a refusal, and it is the point of the whole module.
   */
  | { verdict: 'refuse'; reason: string; trees: UnsavedTree[] };

/**
 * Whether it is safe to rotate right now.
 *
 * `alreadyCheckpointed` is the caller telling us it has just run a checkpoint;
 * anything still unsaved after that is by definition something rotorcc could
 * not save, so the verdict escalates from "save first" to "refuse".
 */
export function assessRotationSafety(
  workload: WorkloadSnapshot,
  options: { alreadyCheckpointed?: boolean } = {},
): RotationSafety {
  if (workload.needsHuman.length > 0) {
    return {
      verdict: 'refuse',
      reason:
        `${workload.needsHuman.length} tree(s) hold work rotorcc cannot save on its own ` +
        `(${summariseBlockers(workload.needsHuman)}). Rotating now would end the session that ` +
        'owns them with the work only on this disk.',
      trees: workload.needsHuman,
    };
  }
  if (workload.savable.length > 0) {
    if (options.alreadyCheckpointed === true) {
      return {
        verdict: 'refuse',
        reason:
          `${workload.savable.length} tree(s) are still unsaved after a checkpoint ran. ` +
          'Something is stopping the save; rotating now would lose that work.',
        trees: workload.savable,
      };
    }
    return {
      verdict: 'save-first',
      reason: `${workload.savable.length} tree(s) hold unpushed work; commit and push before rotating`,
      trees: workload.savable,
    };
  }
  return { verdict: 'safe', reason: 'every watched tree is clean and pushed' };
}

function summariseBlockers(trees: UnsavedTree[]): string {
  const parts: string[] = [];
  const protectedCount = trees.filter((t) => t.protectedBranch).length;
  const midCount = trees.filter((t) => t.midOperation !== null).length;
  const noRemoteCount = trees.filter((t) => t.noRemote).length;
  if (protectedCount > 0) parts.push(`${protectedCount} on a protected branch`);
  if (midCount > 0) parts.push(`${midCount} mid merge/rebase`);
  if (noRemoteCount > 0) parts.push(`${noRemoteCount} with no remote`);
  return parts.join(', ');
}

export interface HeadroomRequirement {
  /**
   * Headroom the work in flight is estimated to need, or null when there is
   * not enough history to say. Null is a real answer and callers must render
   * it as one.
   */
  estimatedPct: number | null;
  /** How that estimate was reached, in one line an operator can argue with. */
  basis: string;
  /** `high` / `medium` / `low` / `none`. Never omitted. */
  confidence: 'high' | 'medium' | 'low' | 'none';
}

/**
 * How much headroom the current work probably needs to finish.
 *
 * Deliberately crude, and deliberately says so. The inputs are the observed
 * burn rate (percentage points per hour, from the burn history) and how long
 * the active sessions have been running. There is no model of "how much work is
 * left" because there is no honest way to get one — an agent does not know how
 * long its own task will take either.
 *
 * What this IS good for: refusing a target with 6% left when the machine has
 * been burning 20 points an hour for the last three hours. That call is
 * defensible, and it is the one a headroom-only switcher gets wrong.
 */
export function estimateHeadroomNeeded(
  workload: WorkloadSnapshot,
  burnPctPerHour: number | null,
  options: { minimumPct?: number; horizonHours?: number } = {},
): HeadroomRequirement {
  const minimum = options.minimumPct ?? 0;
  const horizonHours = options.horizonHours ?? 1;

  if (workload.activeSessions.length === 0) {
    return {
      estimatedPct: minimum > 0 ? minimum : null,
      basis: 'no session has written in the last five minutes; nothing appears to be running',
      confidence: 'none',
    };
  }

  if (burnPctPerHour === null) {
    return {
      estimatedPct: null,
      basis:
        `${workload.activeSessions.length} session(s) are running, but rotorcc has not yet ` +
        'observed enough headroom history to estimate a burn rate',
      confidence: 'none',
    };
  }

  const needed = burnPctPerHour * horizonHours;
  return {
    estimatedPct: Math.max(minimum, needed),
    basis:
      `${workload.activeSessions.length} session(s) running; observed burn ` +
      `${burnPctPerHour.toFixed(1)} points/hour, projected over ${horizonHours}h`,
    // Never higher than medium. This is a linear extrapolation of a bursty
    // process, and dressing it up as "high confidence" is the kind of confident
    // report this tool exists to not produce.
    confidence: burnPctPerHour > 0 ? 'medium' : 'low',
  };
}
