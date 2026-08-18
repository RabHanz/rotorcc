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
import { type Action, type Decision, decide, decideHardKill } from './decide.js';
import {
  performCheckpoint,
  newestSessionAcrossProjects,
  updateStateAfterCheckpoint,
} from './checkpoint.js';
import type { Logger } from './log.js';
import { run } from './proc.js';
import { FLAG_ROTATE_NOW, FLAG_SOFT_CHECKPOINT, Store, timestampSlug } from './state.js';
import { findWindowForCwd, launchSuccessor, retireWindow } from './successor.js';
import { checkLiveness, detectLimitSignature, readTail, unescapeJsonish } from './transcripts.js';
import { type UsageReading, activeAccount, readingFromListOutput } from './usage.js';

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

export async function readUsage(config: Config): Promise<UsageReading | { error: string }> {
  const result = await run([...config.commands.cswap, 'list', '--json'], { timeoutMs: 45_000 });
  if (!result.ok) {
    return { error: `usage source failed: ${(result.error ?? result.stderr).slice(0, 300)}` };
  }
  try {
    return readingFromListOutput(JSON.parse(result.stdout), { models: config.models });
  } catch (err) {
    return { error: `usage source output was not the expected shape: ${String(err)}` };
  }
}

async function detectHardKill(
  ctx: TickContext,
): Promise<{ kind: 'limit-signature' | 'dead-process'; detail: string } | null> {
  if (!ctx.config.hardKill.enabled) return null;
  const session = newestSessionAcrossProjects(ctx.config);
  if (session === null) return null;

  const tail = await readTail(session.transcriptPath, ctx.config.hardKill.tailBytes);
  const signatures = ctx.config.hardKill.transcriptSignatures;
  const direct = detectLimitSignature(tail, signatures);
  const unescaped = direct.hit ? direct : detectLimitSignature(unescapeJsonish(tail), signatures);
  if (unescaped.hit) {
    return { kind: 'limit-signature', detail: `transcript tail matched "${unescaped.signature}"` };
  }

  const liveness = await checkLiveness(ctx.config, session.transcriptPath);
  if (liveness.dead) {
    return {
      kind: 'dead-process',
      detail: `transcript idle for ${Math.round(liveness.idleSeconds)}s with no live process`,
    };
  }
  return null;
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
        store.raiseFlag(FLAG_SOFT_CHECKPOINT, {
          raisedAt: new Date().toISOString(),
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
  taken.push('manifest');
  effects.checkpointed = true;
  effects.manifestPath = checkpoint.manifestPath;

  store.raiseFlag(FLAG_ROTATE_NOW, {
    raisedAt: new Date().toISOString(),
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
    const switched = await run([...config.commands.cswap, 'switch', String(action.targetAccount)], {
      timeoutMs: 60_000,
    });
    if (!switched.ok) {
      logger.error('account switch failed; not launching a successor', {
        detail: (switched.error ?? switched.stderr).slice(0, 300),
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

  const launch = await launchSuccessor({
    config,
    logger,
    cwd,
    prompt,
    dryRun: ctx.dryRun,
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
    const decision =
      kill === null
        ? decide(usage, config, state)
        : decideHardKill(usage, config, state, kill.kind);

    if (kill !== null) logger.error('hard kill detected', { detail: kill.detail });

    const effects: ActionEffects = { taken: [], checkpointed: false, manifestPath: null };
    const actionsTaken = await runActions(ctx, decision, usage, kill?.kind ?? null, effects);

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
