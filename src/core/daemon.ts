/**
 * One tick of the watcher, and the loop that repeats it.
 *
 * The tick is: read usage, look for a hard kill, decide, act. It holds a lock
 * so a hook firing at the same moment cannot checkpoint the same trees
 * concurrently, and it exits rather than queuing if it cannot get one — the
 * next tick is 60 seconds away, and a backlog of watchers is worse than a
 * skipped reading.
 *
 * Cost matters here. This runs on whatever machine the operator is working on,
 * every minute, forever. A tick with nothing to do is two subprocess calls and
 * a handful of stats.
 */
import type { Config } from '../config/schema.js';
import { AccountManager } from '../accounts/manager.js';
import { switchAccount } from '../accounts/switch.js';
import { resolveIdentifier, slots } from '../accounts/roster.js';
import { BurnStore, burnRateFrom } from './burn.js';
import { DecisionJournal } from './history.js';
import { assessRotationSafety, collectWorkload, estimateHeadroomNeeded } from './workload.js';
import {
  type Action,
  type Decision,
  type Level,
  type RotorState,
  decide,
  decideHardKill,
} from './decide.js';
import { PendingSwitchStore } from './nextSession.js';
import { evaluatePolicy, renderStopNotice, weeklyHeadroom } from './policy.js';
import {
  performCheckpoint,
  newestSessionAcrossProjects,
  updateStateAfterCheckpoint,
} from './checkpoint.js';
import type { Logger } from './log.js';
import { run } from './proc.js';
import {
  FLAG_ALL_EXHAUSTED,
  FLAG_ROTATE_NOW,
  FLAG_SOFT_CHECKPOINT,
  Store,
  timestampSlug,
} from './state.js';
import { findWindowForCwd, launchSuccessor, retireWindow } from './successor.js';
import { checkLiveness, detectLimitSignature, readTail, unescapeJsonish } from './transcripts.js';
import {
  type UsageReading,
  activeAccount,
  headroomIsKnown,
  readingFromListOutput,
} from './usage.js';
import { selectTarget } from '../accounts/select.js';

export interface TickContext {
  config: Config;
  store: Store;
  logger: Logger;
  dryRun: boolean;
}

export interface TickResult {
  ok: boolean;
  decision: Decision | null;
  actionsTaken: string[];
  hardKill: 'limit-signature' | 'dead-process' | null;
  detail: string;
}

/**
 * Read every account's headroom.
 *
 * rotorcc reads its OWN accounts, from its own store, over the Anthropic quota
 * endpoint. There is no external switcher in this path any more.
 *
 * The one exception is an explicitly configured `commands.cswap` on a machine
 * where rotorcc manages no accounts of its own. That is the migration case: a
 * box that has not run `rotorcc accounts import` yet should keep working rather
 * than reporting nothing, and the fallback says which source it used so the
 * distinction never has to be inferred.
 */
/** The manager for a config, honouring an explicitly configured accounts dir. */
export function managerFor(config: Config): AccountManager {
  return AccountManager.forConfig(config, {
    ...(config.accountsDir === '' ? {} : { accountsDir: config.accountsDir }),
  });
}

export async function readUsage(config: Config): Promise<UsageReading | { error: string }> {
  const manager = managerFor(config);
  if (manager.hasAccounts()) {
    try {
      return await manager.readUsage();
    } catch (err) {
      return { error: `reading accounts failed: ${String(err).slice(0, 300)}` };
    }
  }
  return legacyUsage(config);
}

/**
 * The pre-native reader, kept only for machines mid-migration.
 *
 * Every failure here names the fallback explicitly. An operator whose accounts
 * never got imported must find that out from the message, not from wondering
 * why nothing rotates.
 */
async function legacyUsage(config: Config): Promise<UsageReading | { error: string }> {
  const result = await run([...config.commands.cswap, 'list', '--json'], { timeoutMs: 45_000 });
  if (!result.ok) {
    return {
      error:
        'rotorcc manages no accounts of its own, and the external switcher fallback also failed ' +
        `(${(result.error ?? result.stderr).slice(0, 200)}). ` +
        'Run "rotorcc accounts import --from-cswap" or "rotorcc accounts add".',
    };
  }
  try {
    return readingFromListOutput(JSON.parse(result.stdout), { models: config.models });
  } catch (err) {
    return {
      error:
        'rotorcc manages no accounts of its own, and the external switcher emitted a shape ' +
        `rotorcc does not recognise: ${String(err).slice(0, 200)}. ` +
        'Run "rotorcc accounts import --from-cswap" to stop depending on it.',
    };
  }
}

async function detectHardKill(
  ctx: TickContext,
): Promise<{ kind: 'limit-signature' | 'dead-process'; detail: string } | null> {
  if (!ctx.config.hardKill.enabled) return null;
  const session = newestSessionAcrossProjects(ctx.config);
  if (session === null) return null;

  // Liveness is the GROUND TRUTH and is checked first. A signature in the
  // transcript is only ever corroborating evidence, never sufficient on its own.
  //
  // 2026-08-19: this launched a duplicate session onto a LIVE one. The transcript
  // tail carried "You've hit your session limit" — but that was six SUBAGENTS
  // dying, recorded as their task-notification results, not the main session. The
  // detector matched the string and declared the whole session hard-killed while
  // its process was still running and working. Two `claude --continue` then shared
  // one worktree. A successor must NEVER be launched while the predecessor is
  // alive: that is not resumption, it is corruption.
  const liveness = await checkLiveness(ctx.config, session.transcriptPath);
  if (!liveness.dead) {
    // The session process is alive. Whatever the transcript says, it is not dead.
    // A limit message from a subagent is not a reason to replace a working
    // operator. Do nothing.
    return null;
  }

  const tail = await readTail(session.transcriptPath, ctx.config.hardKill.tailBytes);
  const signatures = ctx.config.hardKill.transcriptSignatures;
  const direct = detectLimitSignature(tail, signatures);
  const unescaped = direct.hit ? direct : detectLimitSignature(unescapeJsonish(tail), signatures);
  if (unescaped.hit) {
    // Dead process AND a limit signature: a real hard kill.
    return {
      kind: 'limit-signature',
      detail: `process gone and transcript tail matched "${unescaped.signature}"`,
    };
  }

  // Dead process with no signature: idle death (crash, closed terminal).
  return {
    kind: 'dead-process',
    detail: `transcript idle for ${Math.round(liveness.idleSeconds)}s with no live process`,
  };
}

export interface ActionEffects {
  taken: string[];
  checkpointed: boolean;
  manifestPath: string | null;
}

async function runActions(
  ctx: TickContext,
  decision: Decision,
  usage: UsageReading,
  hardKill: string | null,
  effects: ActionEffects,
): Promise<string[]> {
  const taken = effects.taken;
  const { config, store, logger } = ctx;

  for (const action of decision.actions) {
    switch (action.kind) {
      case 'log-warning':
        logger.warn('account headroom is getting low', {
          headroomPct: decision.headroomPct,
          window: decision.bindingWindow,
        });
        taken.push('log-warning');
        break;

      case 'blocked':
        logger.warn(`rotation blocked: ${action.reason}`);
        taken.push(`blocked: ${action.reason}`);
        break;

      case 'soft-checkpoint': {
        const result = await performCheckpoint({
          config,
          store,
          logger,
          trigger: hardKill !== null ? `hard-kill:${hardKill}` : 'soft-checkpoint',
          dryRun: ctx.dryRun,
          usage,
          writeManifest: false,
        });
        const stamp = timestampSlug();
        store.writeAtomic(
          `soft-checkpoint-${stamp}.json`,
          `${JSON.stringify(
            {
              at: new Date().toISOString(),
              headroomPct: decision.headroomPct,
              bindingWindow: decision.bindingWindow,
              trees: result.projects.flatMap((p) =>
                p.outcomes.map((o) => ({
                  tree: o.tree,
                  branch: o.branch,
                  committed: o.committed,
                  pushed: o.pushed,
                  skipped: o.skipped,
                  error: o.error,
                })),
              ),
              snapshotCommit: result.snapshot?.commit ?? null,
            },
            null,
            2,
          )}\n`,
        );
        if (ctx.dryRun) {
          // Same rule as ROTATE_NOW. A simulated checkpoint request that
          // reaches a live session is a false instruction, not a harmless note.
          logger.info('dry run: would raise SOFT_CHECKPOINT_REQUESTED');
          taken.push('dry-run-flag-suppressed');
          effects.checkpointed = true;
          taken.push('soft-checkpoint');
          break;
        }
        store.raiseFlag(FLAG_SOFT_CHECKPOINT, {
          raisedAt: new Date().toISOString(),
          level: 'soft',
          reason:
            `Account headroom is down to ${decision.headroomPct.toFixed(0)}% on the ` +
            `${decision.bindingWindow} window. rotorcc has already committed and pushed every ` +
            'lane it is allowed to touch. Have every running agent commit, push and write its ' +
            'resume note now; do not start anything new that cannot finish in a few minutes.',
          headroomPct: decision.headroomPct,
        });
        effects.checkpointed = true;
        taken.push('soft-checkpoint');
        break;
      }

      case 'rotate': {
        const rotated = await rotate(ctx, decision, usage, action, hardKill, effects);
        taken.push(...rotated);
        break;
      }
    }
  }
  return taken;
}

async function rotate(
  ctx: TickContext,
  decision: Decision,
  usage: UsageReading,
  action: Extract<Action, { kind: 'rotate' }>,
  hardKill: string | null,
  effects: ActionEffects,
): Promise<string[]> {
  const { config, store, logger } = ctx;
  const taken: string[] = [];
  const active = activeAccount(usage);

  // The manifest is written BEFORE anything is switched. If the switch fails,
  // or the successor never starts, the resume plan still exists on disk.
  const session = newestSessionAcrossProjects(config);
  const checkpoint = await performCheckpoint({
    config,
    store,
    logger,
    trigger: hardKill !== null ? `rotate:hard-kill:${hardKill}` : 'rotate',
    dryRun: ctx.dryRun,
    usage,
    targetAccount: action.targetAccount,
    writeManifest: true,
    cleanExit: false,
    session:
      session === null
        ? undefined
        : {
            id: session.sessionId,
            transcriptPath: session.transcriptPath,
            cwd: session.projectPath,
            backgroundTasks: [],
            lastAssistantMessage: null,
          },
  });
  taken.push(ctx.dryRun ? 'dry-run-manifest' : 'manifest');
  effects.checkpointed = true;
  // A simulated manifest must never become `state.lastManifestPath`: that is
  // what `rotorcc resume` and the crash-reconstruction hook reach for, and
  // handing them a document whose every row says "would commit" is how a
  // simulation gets presented as a rescue.
  effects.manifestPath = ctx.dryRun ? null : checkpoint.manifestPath;

  // A dry run does not raise a live flag. On 2026-08-18 one that did was read
  // by the UserPromptSubmit hook hours later, on a healthy session with 72%
  // headroom and rotation disabled, and told the orchestrator to exit. A flag
  // is an instruction to a live session; a simulation must not be able to
  // issue one.
  if (ctx.dryRun) {
    logger.info('dry run: would raise ROTATE_NOW', { target: action.targetAccount });
    taken.push('dry-run-flag-suppressed');
  } else {
    store.raiseFlag(FLAG_ROTATE_NOW, {
      raisedAt: new Date().toISOString(),
      level: 'rotate',
      reason:
        `Account ${active?.number ?? '?'} is down to ${decision.headroomPct.toFixed(0)}% on the ` +
        `${decision.bindingWindow} window. rotorcc is rotating to account ${action.targetAccount}. ` +
        'Finish the tool call you are in, order every agent to commit, push and write its resume ' +
        'note, then stop dispatching new work and exit. A replacement session is starting with the ' +
        'manifest below.',
      ...(checkpoint.manifestPath !== null ? { manifestPath: checkpoint.manifestPath } : {}),
      ...(checkpoint.manifestMarkdownPath !== null
        ? { manifestMarkdownPath: checkpoint.manifestMarkdownPath }
        : {}),
      targetAccount: action.targetAccount,
      headroomPct: decision.headroomPct,
    });
  }

  const cwd =
    config.successor.cwd !== ''
      ? config.successor.cwd
      : (config.projects[0]?.path ?? process.cwd());

  // Note the predecessor's window before switching, while it is still findable.
  const predecessor =
    config.successor.launcher === 'tmux' ? await findWindowForCwd(config, cwd) : null;

  if (ctx.dryRun) {
    logger.info('dry run: would switch account', { target: action.targetAccount });
    taken.push(`dry-run-switch:${action.targetAccount}`);
  } else {
    const switched = await performSwitch(config, action.targetAccount, logger);
    if (!switched.ok) {
      logger.error('account switch failed; not launching a successor', {
        detail: switched.detail.slice(0, 300),
      });
      taken.push('switch-failed');
      return taken;
    }
    logger.info('account switched', { target: action.targetAccount });
    taken.push(`switched:${action.targetAccount}`);
  }

  const prompt = config.successor.resumePrompt
    .replace(/\{\{manifestMarkdown\}\}/g, checkpoint.manifestMarkdownPath ?? '(no manifest)')
    .replace(/\{\{manifestJson\}\}/g, checkpoint.manifestPath ?? '(no manifest)')
    .replace(/\{\{account\}\}/g, String(action.targetAccount));

  // Re-check liveness at the moment of launch, not from any earlier reading. A
  // successor replaces a DEAD session; if this operator is still alive, launching
  // beside it puts two operators on one worktree. This is the fact that must gate
  // the launch, and it is taken fresh here so no stale decision can bypass it.
  //
  // The session checked is the one this rotation was decided FOR, carried down
  // from the top of the tick — not a fresh `newestSessionAcrossProjects()`. On a
  // machine with several worktrees those can be different sessions, and
  // confirming that some other session is dead is not evidence about this one.
  //
  // When there is no session to check at all, `predecessorAlive` stays
  // undefined and the gate in `launchSuccessor` refuses. An absent session is
  // not a dead one; it is an unanswered question.
  const predecessorTranscript = session?.transcriptPath;
  const predecessorAlive =
    predecessorTranscript === undefined || predecessorTranscript === ''
      ? undefined
      : !(await checkLiveness(config, predecessorTranscript)).dead;
  const launch = await launchSuccessor({
    config,
    logger,
    cwd,
    prompt,
    dryRun: ctx.dryRun,
    preferTarget: predecessor ?? undefined,
    ...(predecessorAlive === undefined ? {} : { predecessorAlive }),
  });
  logger.info('successor launch', {
    ok: launch.ok,
    detail: launch.detail,
    promptConfirmed: launch.promptConfirmed,
  });
  taken.push(`successor:${launch.ok ? 'launched' : 'failed'}`);

  if (predecessor !== null && launch.ok && launch.handle !== predecessor) {
    const retired = await retireOnQuiesce(ctx, predecessor);
    taken.push(`predecessor:${retired}`);
  }

  return taken;
}

/**
 * Switch to `targetAccount`.
 *
 * Native when rotorcc manages the account itself, which is the path everyone
 * ends up on. The external-switcher branch survives only for a machine that
 * has not run `rotorcc accounts import` yet, and it says which path it took so
 * nobody has to infer it from behaviour.
 */
async function performSwitch(
  config: Config,
  targetAccount: number,
  logger: Logger,
): Promise<{ ok: boolean; detail: string }> {
  const manager = managerFor(config);
  if (manager.hasAccounts()) {
    const resolved = resolveIdentifier(manager.roster.read(), String(targetAccount));
    if (resolved.kind !== 'found') {
      return { ok: false, detail: `slot ${targetAccount} is not in rotorcc's roster` };
    }
    const result = await switchAccount({
      roster: manager.roster,
      credentials: manager.credentials,
      target: resolved.slot,
    });
    for (const warning of result.warnings) logger.warn(`switch: ${warning}`);
    return { ok: result.ok, detail: result.detail };
  }

  const switched = await run([...config.commands.cswap, 'switch', String(targetAccount)], {
    timeoutMs: 60_000,
  });
  if (!switched.ok) {
    return {
      ok: false,
      detail:
        'rotorcc manages no accounts of its own, so it fell back to the external switcher, ' +
        `which failed: ${(switched.error ?? switched.stderr).slice(0, 200)}`,
    };
  }
  return { ok: true, detail: `switched via the external switcher fallback to ${targetAccount}` };
}

/**
 * Wait for the predecessor's transcript to stop growing before closing its
 * window, and snapshot once more on the way out. Kill first and the last tool
 * call's output is lost, which is the exact failure this tool exists to stop.
 */
async function retireOnQuiesce(ctx: TickContext, handle: string): Promise<string> {
  const { config, store, logger } = ctx;
  if (!config.retire.killOldWindow) return 'left-running';

  const deadline = Date.now() + config.retire.maxWaitSeconds * 1000;
  let lastSize = -1;
  let quietSince = Date.now();

  while (Date.now() < deadline) {
    const session = newestSessionAcrossProjects(config);
    const size = session?.bytes ?? -1;
    if (size !== lastSize) {
      lastSize = size;
      quietSince = Date.now();
    } else if ((Date.now() - quietSince) / 1000 >= config.retire.quiesceSeconds) {
      await performCheckpoint({
        config,
        store,
        logger,
        trigger: 'pre-retire',
        dryRun: ctx.dryRun,
        writeManifest: false,
      });
      const result = await retireWindow(config, logger, handle, ctx.dryRun);
      return result.killed ? 'closed' : `left-running (${result.detail})`;
    }
    await new Promise((r) => setTimeout(r, 10_000));
  }
  logger.warn('predecessor never went quiet; leaving its window alone', { handle });
  return 'left-running (never quiesced)';
}

/**
 * The weekly-priority policy, applied to a machine with no dead session.
 *
 * Returns null when the policy has nothing to say and the older threshold
 * machinery should run instead (which is where warn/soft checkpointing and the
 * latches live). Returns a decision when the policy itself is the answer:
 *
 *   handover  record which account the NEXT session opens on. The running one
 *             is untouched — that is the whole point of the redesign.
 *   stop      every account is spent. Nothing is rotated, nothing is spawned,
 *             nothing is queued, and the operator is told plainly.
 *   checkpoint the 5-hour window is low but the week is fine: save and stay.
 *
 * Nothing in here launches a process. A successor is only ever a replacement
 * for a session whose process is gone, and that path is reached elsewhere.
 */
async function applySessionPolicy(
  ctx: TickContext,
  usage: UsageReading,
): Promise<{ decision: Decision; actionsTaken: string[]; level: Level } | null> {
  const { config, store, logger } = ctx;

  // Is a session actually alive? This decides whether a handover takes effect
  // now or at the next start, and it is a FACT we check rather than infer.
  const session = newestSessionAcrossProjects(config);
  const sessionAlive =
    session === null ? false : !(await checkLiveness(config, session.transcriptPath)).dead;

  const action = evaluatePolicy({ reading: usage, config, sessionAlive });
  const active = activeAccount(usage);
  const activeWeekly =
    active === null ? { pct: null, window: 'unknown' } : weeklyHeadroom(active, config.models);

  const state = store.readState();

  /**
   * Fire at most once per quota window.
   *
   * Without this the policy would checkpoint on EVERY tick for as long as the
   * window stays low — a commit and a push every sixty seconds for four hours,
   * which is precisely what the latches in `decide()` were built to prevent and
   * what a busy orchestrator experienced in production on 2026-08-18.
   *
   * Keyed on the reset time of the window that drove the decision, so a window
   * rolling over re-arms it and nothing else does.
   */
  const windowKey = `${action.kind}:${active?.bindingResetsAt ?? activeWeekly.window}`;
  const latched = state.policyLatch?.windowKey === windowKey;
  const armLatch = (): RotorState => ({
    ...state,
    policyLatch: { windowKey, at: new Date().toISOString() },
    latchedAccount: active?.number ?? state.latchedAccount,
  });

  const asDecision = (reason: string, level: Level, actions: Decision['actions']): Decision => ({
    level,
    headroomPct: activeWeekly.pct ?? 0,
    bindingWindow: activeWeekly.window,
    activeAccount: active?.number ?? null,
    actions,
    reason,
    nextState: store.readState(),
  });

  switch (action.kind) {
    case 'none':
    case 'warn':
      // Let the existing threshold machinery handle warn-level behaviour; it
      // owns the latches and the hysteresis and there is no reason to duplicate
      // that here.
      return null;

    case 'checkpoint': {
      if (latched) {
        // Already saved for this window. Say so rather than doing it again.
        return {
          decision: asDecision(
            `${action.reason} (already checkpointed for this window)`,
            'soft',
            [],
          ),
          actionsTaken: [],
          level: 'soft',
        };
      }
      const result = await performCheckpoint({
        config,
        store,
        logger,
        trigger: 'policy:five-hour-low',
        dryRun: ctx.dryRun,
        usage,
        writeManifest: false,
      });
      const pushed = result.projects.reduce(
        (n, p) => n + p.outcomes.filter((o) => o.pushed).length,
        0,
      );
      logger.info('five-hour window low, weekly healthy: checkpointed and stayed put', {
        pushed,
      });
      return {
        decision: {
          ...asDecision(action.reason, 'soft', [{ kind: 'soft-checkpoint' }]),
          nextState: armLatch(),
        },
        actionsTaken: ['policy-checkpoint'],
        level: 'soft',
      };
    }

    case 'stop': {
      if (latched) {
        // The notice has already been given for this window. Repeating a
        // full-screen stop banner every sixty seconds trains an operator to
        // scroll past it, which defeats the one job it has.
        return {
          decision: asDecision(`STOPPED — ${action.reason} (notice already given)`, 'rotate', [
            { kind: 'blocked', reason: action.reason },
          ]),
          actionsTaken: [],
          level: 'rotate',
        };
      }
      // Save what can be saved, then stop and make sure a human sees it.
      await performCheckpoint({
        config,
        store,
        logger,
        trigger: 'policy:all-accounts-exhausted',
        dryRun: ctx.dryRun,
        usage,
        writeManifest: true,
        cleanExit: false,
      });

      const notice = renderStopNotice(action);
      logger.error('ALL ACCOUNTS EXHAUSTED — rotorcc has stopped and is waiting for a human');
      // Straight to stderr as well as the log. This is the one situation where
      // rotorcc has nothing useful left to do, and a line buried in a log file
      // is not the operator finding out.
      process.stderr.write(notice);

      if (!ctx.dryRun) {
        store.raiseFlag(FLAG_ALL_EXHAUSTED, {
          raisedAt: new Date().toISOString(),
          level: 'rotate',
          reason: action.reason,
        });
      }

      return {
        decision: {
          ...asDecision(`STOPPED — ${action.reason}`, 'rotate', [
            { kind: 'blocked', reason: action.reason },
            { kind: 'soft-checkpoint' },
          ]),
          nextState: armLatch(),
        },
        actionsTaken: ['policy-stop', 'manifest'],
        level: 'rotate',
      };
    }

    case 'handover': {
      if (latched) {
        // The intent is already recorded for this window. Re-recording it is
        // harmless, but the checkpoint beside it is not — that is a commit and
        // a push every sixty seconds until the window resets.
        return {
          decision: asDecision(`${action.reason} (handover already queued)`, 'soft', []),
          actionsTaken: [],
          level: 'soft',
        };
      }
      const pending = new PendingSwitchStore(store.dir);
      pending.record({
        slot: action.slot,
        reason: action.reason,
        decidedAt: new Date().toISOString(),
        fromHeadroomPct: activeWeekly.pct,
        window: action.window,
        dryRun: ctx.dryRun,
      });

      // Checkpoint too. The handover takes effect at the next session start,
      // and between now and then this session keeps working on an account that
      // is nearly out — so its work should already be safe.
      await performCheckpoint({
        config,
        store,
        logger,
        trigger: 'policy:handover-queued',
        dryRun: ctx.dryRun,
        usage,
        writeManifest: false,
      });

      logger.info('queued an account handover for the next session', {
        slot: action.slot,
        sessionAlive,
        dryRun: ctx.dryRun,
      });

      return {
        decision: {
          ...asDecision(action.reason, 'soft', [
            {
              kind: 'blocked',
              reason: 'handover queued for the next session; nothing interrupted',
            },
            { kind: 'soft-checkpoint' },
          ]),
          nextState: armLatch(),
        },
        actionsTaken: [
          ctx.dryRun ? 'dry-run-handover-queued' : 'handover-queued',
          'soft-checkpoint',
        ],
        level: 'soft',
      };
    }
  }
}

/**
 * The work-aware gate: reconsider a rotation in the light of what is running.
 *
 * A plain switcher asks "which account has the most left". rotorcc asks two
 * more questions first, and either can turn a rotation into a refusal:
 *
 *   1. Is anything unsaved that rotorcc could not save? Rotating ends the
 *      session that owns it. A checkpoint runs instead, and the refusal is
 *      recorded with the trees that caused it.
 *
 *   2. Does the chosen target have enough headroom to FINISH? An account with
 *      the most left is still the wrong answer if the work needs more than it
 *      has — that costs a second rotation and a second cold start half an hour
 *      later.
 *
 * When the gate cannot answer — no burn history, worktrees not inspectable —
 * it says so and leaves the original decision alone rather than blocking on an
 * unknown. Refusing on the strength of something it does not know would be the
 * same overconfidence in the other direction.
 */
async function applyWorkAwareGate(
  ctx: TickContext,
  decision: Decision,
  usage: UsageReading,
  burn: BurnStore,
  /** The state BEFORE this tick, so a refusal can restore what `decide()` set. */
  state: RotorState,
): Promise<{ decision: Decision; unsavedTrees: number | null }> {
  const rotateAction = decision.actions.find((a) => a.kind === 'rotate');
  if (rotateAction === undefined) return { decision, unsavedTrees: null };

  let workload;
  try {
    workload = await collectWorkload(ctx.config);
  } catch (err) {
    ctx.logger.warn('could not inspect worktrees before rotating', {
      detail: String(err).slice(0, 200),
    });
    return { decision, unsavedTrees: null };
  }

  const unsavedTrees = workload.unsaved.length;

  if (ctx.config.refuseRotationWithUnsavedWork) {
    const safety = assessRotationSafety(workload);
    if (safety.verdict === 'refuse') {
      // Checkpoint instead of rotating. The manifest and the flag still get
      // written by the soft-checkpoint path, so the operator gets the full
      // rescue record — they simply do not get moved off the account while
      // work is sitting somewhere rotorcc cannot reach.
      return {
        decision: {
          ...decision,
          actions: [
            { kind: 'blocked', reason: `work-aware refusal: ${safety.reason}` },
            { kind: 'soft-checkpoint' },
          ],
          reason: `${decision.reason}; ROTATION REFUSED — ${safety.reason}`,
          // The rotation did not happen, so the state must not record one.
          //
          // `decide()` sets these optimistically when it selects a target. This
          // used to copy them straight through, which was a no-op dressed up as
          // a correction: the cooldown would then believe a rotation had just
          // occurred and suppress the NEXT one, which is the one that might
          // actually have been allowed to run.
          nextState: {
            ...decision.nextState,
            lastRotationAt: state.lastRotationAt,
            lastRotationTarget: state.lastRotationTarget,
          },
        },
        unsavedTrees,
      };
    }
  }

  if (ctx.config.strategy !== 'work-aware') return { decision, unsavedTrees };

  const active = activeAccount(usage);
  const rate = active === null ? null : burnRateFrom(burn.series(active.number));
  const requirement = estimateHeadroomNeeded(workload, rate?.pctPerHour ?? null, {
    minimumPct: ctx.config.minTargetHeadroomPct,
  });
  if (requirement.estimatedPct === null) return { decision, unsavedTrees };

  const target = usage.accounts.find((a) => a.number === rotateAction.targetAccount);
  if (target === undefined || !headroomIsKnown(target)) return { decision, unsavedTrees };
  if (target.headroomPct >= requirement.estimatedPct) return { decision, unsavedTrees };

  const better = selectTarget(usage, {
    strategy: 'work-aware',
    activeNumber: usage.activeAccountNumber,
    minHeadroomPct: ctx.config.minTargetHeadroomPct,
    neededHeadroomPct: requirement.estimatedPct,
  });

  if (better.chosen === null) {
    return {
      decision: {
        ...decision,
        actions: [{ kind: 'blocked', reason: better.reason }, { kind: 'soft-checkpoint' }],
        reason: `${decision.reason}; ROTATION REFUSED — ${better.reason}`,
        // Same reason as the refusal above: no rotation happened, so the
        // cooldown must not think one did.
        nextState: {
          ...decision.nextState,
          lastRotationAt: state.lastRotationAt,
          lastRotationTarget: state.lastRotationTarget,
        },
      },
      unsavedTrees,
    };
  }

  if (better.chosen.number === rotateAction.targetAccount) return { decision, unsavedTrees };

  return {
    decision: {
      ...decision,
      actions: decision.actions.map((a) =>
        a.kind === 'rotate'
          ? { kind: 'rotate', targetAccount: better.chosen?.number ?? a.targetAccount }
          : a,
      ),
      reason: `${decision.reason}; retargeted by work-aware sizing — ${better.reason}`,
      nextState: {
        ...decision.nextState,
        lastRotationTarget: better.chosen.number,
      },
    },
    unsavedTrees,
  };
}

/**
 * Record what this tick decided, including when it decided nothing.
 *
 * The idle entries are the point. On 2026-08-19 the watcher decided "do
 * nothing" for hours while an operator burned to 99%, and afterwards there was
 * no record that it had decided anything at all. A screen that can show two
 * hundred consecutive refusals beside the headroom that caused them is the
 * difference between diagnosing that in a minute and losing a session to it.
 */
function journalDecision(
  ctx: TickContext,
  decision: Decision,
  actionsTaken: string[],
  unsavedTrees: number | null,
): void {
  const journal = new DecisionJournal(ctx.store.dir);
  const kind = actionsTaken.some((a) => a.startsWith('switched'))
    ? 'rotated'
    : decision.reason.includes('ROTATION REFUSED')
      ? 'refused'
      : actionsTaken.some((a) => a.startsWith('blocked'))
        ? 'blocked'
        : actionsTaken.includes('soft-checkpoint') || actionsTaken.includes('manifest')
          ? 'checkpointed'
          : actionsTaken.includes('log-warning')
            ? 'warned'
            : 'idle';

  const active = decision.activeAccount;
  const knownHeadroom = decision.actions.length > 0 || decision.level !== 'ok' || active !== null;
  journal.record({
    kind,
    activeAccount: active,
    targetAccount:
      (decision.actions.find((a) => a.kind === 'rotate') as { targetAccount?: number } | undefined)
        ?.targetAccount ?? null,
    // Null, never a placeholder: an account with no active reading has no
    // headroom to record, and a zero here would read as "it was empty".
    headroomPct: active === null || !knownHeadroom ? null : decision.headroomPct,
    bindingWindow: decision.bindingWindow,
    reason: decision.reason,
    strategy: ctx.config.strategy,
    dryRun: ctx.dryRun,
    unsavedTrees,
  });
}

export async function tick(ctx: TickContext): Promise<TickResult> {
  const { config, store, logger } = ctx;

  if (!store.acquireLock('tick', Math.max(300, config.pollSeconds * 5))) {
    return {
      ok: true,
      decision: null,
      actionsTaken: [],
      hardKill: null,
      detail: 'another rotorcc operation holds the lock; skipping this tick',
    };
  }

  try {
    const usage = await readUsage(config);
    if ('error' in usage) {
      logger.warn(usage.error);
      return { ok: false, decision: null, actionsTaken: [], hardKill: null, detail: usage.error };
    }

    const state = store.readState();
    const kill = await detectHardKill(ctx);

    // Record a burn sample for every account we could actually measure. Only
    // measured ones: a placeholder zero here becomes a cliff in the series and
    // the next prediction claims the account dies in ninety seconds.
    const burn = new BurnStore(store.dir);
    for (const account of usage.accounts) burn.record(account);

    // ---------------------------------------------------------------------
    // The weekly-priority policy, evaluated FIRST.
    //
    // A live session cannot have its account changed underneath it, so the
    // watcher's job while one is running is to warn, checkpoint, and record
    // which account the NEXT session should open on. It never interrupts, and
    // it never spawns a companion. The old model did both and put two sessions
    // on one worktree (2026-08-19).
    //
    // The successor path below survives only for a session that is genuinely
    // DEAD — `kill !== null` means the process is gone, verified by liveness.
    // ---------------------------------------------------------------------
    if (kill === null) {
      const policyResult = await applySessionPolicy(ctx, usage);
      if (policyResult !== null) {
        journalDecision(ctx, policyResult.decision, policyResult.actionsTaken, null);
        // The policy's own `nextState` carries its latch; without persisting it
        // the latch never arms and the checkpoint repeats every tick.
        store.writeState({ ...policyResult.decision.nextState, lastLevel: policyResult.level });
        return {
          ok: true,
          decision: policyResult.decision,
          actionsTaken: policyResult.actionsTaken,
          hardKill: null,
          detail: policyResult.decision.reason,
        };
      }
    }

    const baseDecision =
      kill === null
        ? decide(usage, config, state)
        : decideHardKill(usage, config, state, kill.kind);

    if (kill !== null) logger.error('hard kill detected', { detail: kill.detail });

    // The work-in-flight gate. This is what a headroom-only switcher cannot do,
    // and it runs BEFORE any rotation action, not after.
    const gated = await applyWorkAwareGate(ctx, baseDecision, usage, burn, state);
    const decision = gated.decision;

    const effects: ActionEffects = { taken: [], checkpointed: false, manifestPath: null };
    const actionsTaken = await runActions(ctx, decision, usage, kill?.kind ?? null, effects);

    journalDecision(ctx, decision, actionsTaken, gated.unsavedTrees);

    let nextState = decision.nextState;
    if (effects.checkpointed) {
      nextState = updateStateAfterCheckpoint(nextState, {
        snapshot: null,
        projects: [],
        manifestPath: effects.manifestPath,
        manifestMarkdownPath: null,
        manifest: null,
      });
    }
    store.writeState(nextState);

    if (actionsTaken.length > 0) logger.info('tick acted', { actions: actionsTaken });
    else logger.debug('tick idle', { reason: decision.reason });

    return {
      ok: true,
      decision,
      actionsTaken,
      hardKill: kill?.kind ?? null,
      detail: decision.reason,
    };
  } finally {
    store.releaseLock('tick');
  }
}

export async function loop(ctx: TickContext, signal?: AbortSignal): Promise<void> {
  ctx.logger.info('rotorcc daemon started', {
    pollSeconds: ctx.config.pollSeconds,
    thresholds: ctx.config.thresholds,
    dryRun: ctx.dryRun,
  });
  while (signal?.aborted !== true) {
    try {
      await tick(ctx);
    } catch (err) {
      ctx.logger.error('tick threw', { detail: String(err).slice(0, 400) });
    }
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, ctx.config.pollSeconds * 1000);
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve(undefined);
      });
    });
  }
  ctx.logger.info('rotorcc daemon stopped');
}
