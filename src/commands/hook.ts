/**
 * `rotorcc hook <Event>` — the single entry point every installed hook calls.
 *
 * Two rules govern everything here.
 *
 * 1. It must be fast. A hook runs inside the agent's tool loop; a slow one is a
 *    tax on every tool call the operator makes. So the synchronous part only
 *    reads small files, and the transcript copy and the git pushes are handed
 *    to a detached child process that outlives this one.
 *
 * 2. It must fail open. A backup tool that can block work is worse than no
 *    backup tool. Every failure path here exits 0 with a logged warning. The
 *    only thing a rotorcc hook ever writes to stdout is a JSON response asking
 *    for context to be injected.
 */
import { spawn } from 'node:child_process';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { type Config } from '../config/schema.js';
import { loadConfig } from '../config/load.js';
import { performCheckpoint } from '../core/checkpoint.js';
import { Logger } from '../core/log.js';
import { parseManifest } from '../core/manifest.js';
import { appPaths } from '../core/paths.js';
import { type HookPayload, parseHookPayload, renderHookResponse } from '../core/hookPayload.js';
import { FLAG_ROTATE_NOW, FLAG_SOFT_CHECKPOINT, Store } from '../core/state.js';
import { PendingSwitchStore } from '../core/nextSession.js';
import { managerFor } from '../core/daemon.js';
import { resolveIdentifier } from '../accounts/roster.js';
import { switchAccount } from '../accounts/switch.js';

export interface HookOptions {
  event: string;
  configPath?: string | undefined;
  /** Read stdin instead of using the supplied payload. Tests pass a payload. */
  payloadText?: string | undefined;
  /** Do the heavy work here rather than detaching. Used by the detached child. */
  inline?: boolean;
  /** Where the detached child finds its payload. Consumed and deleted. */
  payloadFile?: string | undefined;
}

export interface HookResult {
  exitCode: number;
  stdout: string | null;
}

function readStdin(): string {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

/** Events whose whole job is to make work durable. */
const CHECKPOINT_EVENTS = new Set(['SubagentStop', 'Stop', 'SessionEnd']);
/** Events that only need the transcript copied, not every lane pushed. */
const SNAPSHOT_ONLY_EVENTS = new Set(['PreCompact', 'PostCompact']);

function debounced(store: Store, config: Config, event: string): boolean {
  if (config.snapshot.debounceSeconds <= 0) return false;
  // SessionEnd is the last chance there will ever be; it is never debounced.
  if (event === 'SessionEnd') return false;
  try {
    const raw = readFileSync(store.absolute('last-hook-checkpoint'), 'utf8').trim();
    const last = Date.parse(raw);
    if (Number.isNaN(last)) return false;
    return (Date.now() - last) / 1000 < config.snapshot.debounceSeconds;
  } catch {
    return false;
  }
}

function markCheckpointed(store: Store): void {
  try {
    store.ensure();
    writeFileSync(store.absolute('last-hook-checkpoint'), `${new Date().toISOString()}\n`, 'utf8');
  } catch {
    /* the debounce is an optimisation, not a correctness requirement */
  }
}

/** Keep the live task registry on disk, so a crash recovery can still read it. */
function recordTasks(store: Store, payload: HookPayload): void {
  if (payload.background_tasks === undefined) return;
  try {
    store.ensure();
    writeFileSync(
      store.absolute('last-tasks.json'),
      `${JSON.stringify(
        {
          at: new Date().toISOString(),
          sessionId: payload.session_id ?? null,
          transcriptPath: payload.transcript_path ?? null,
          cwd: payload.cwd ?? null,
          tasks: payload.background_tasks,
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
  } catch {
    /* best effort */
  }
}

/**
 * Turn a raised flag into context for the live session.
 *
 * The cross-check against `state.lastLevel` is the whole reason this is not a
 * bare `readFlag`. A hook is the one place a flag becomes an INSTRUCTION to a
 * running agent, and on 2026-08-18 a `ROTATE_NOW` left behind by a dry run was
 * surfaced here hours later to a healthy session — 72% headroom, rotation
 * disabled — and told the orchestrator to exit.
 *
 * `state.lastLevel` is what the most recent tick actually observed, it costs
 * one file read, and a flag whose level no longer holds is dropped from disk
 * rather than merely ignored: leaving it there means the next reader that
 * forgets this check obeys it.
 */
function flagContext(store: Store): { additionalContext: string; systemMessage: string } | null {
  const currentLevel = store.readState().lastLevel;
  const rotate = store.readFlag(FLAG_ROTATE_NOW, { currentLevel });
  if (rotate !== null) {
    const manifest = rotate.manifestMarkdownPath ?? rotate.manifestPath ?? '(none written)';
    return {
      systemMessage: `rotorcc: ROTATION IN PROGRESS — resume plan at ${manifest}`,
      additionalContext: [
        '<rotorcc-alert level="rotate">',
        rotate.reason,
        '',
        `Resume manifest: ${manifest}`,
        '',
        'Do this now, in order: finish the tool call you are in; tell every running agent to',
        'commit, push and write its resume note; stop dispatching new work; then exit. A',
        'replacement session has been started on a fresh account and pointed at the manifest.',
        '</rotorcc-alert>',
      ].join('\n'),
    };
  }

  const soft = store.readFlag(FLAG_SOFT_CHECKPOINT, { currentLevel });
  if (soft !== null) {
    // `?? 0` here would have told the operator "0% headroom left" whenever the
    // figure was simply absent — a number invented out of a missing field, and
    // the most alarming one available.
    const headroom =
      soft.headroomPct === undefined
        ? 'headroom unknown'
        : `${Math.round(soft.headroomPct)}% headroom left`;
    return {
      systemMessage: `rotorcc: soft checkpoint requested (${headroom})`,
      additionalContext: [
        '<rotorcc-alert level="soft-checkpoint">',
        soft.reason,
        '',
        'rotorcc has already committed and pushed every lane it is allowed to touch. What it',
        'cannot do is write your resume notes. Have each agent record where it got to, then',
        'prefer short, finishable work until the window resets.',
        '</rotorcc-alert>',
      ].join('\n'),
    };
  }
  return null;
}

/**
 * Apply a pending account handover, before the session reads its credential.
 *
 * Returns a message for the operator when something happened, null when there
 * was nothing to do. A failure is reported and swallowed: a hook must never
 * block a session from starting, and starting on the previous account is a far
 * better outcome than not starting at all.
 */
async function applyPendingSwitch(
  config: Config,
  store: Store,
  logger: Logger,
): Promise<string | null> {
  const pending = new PendingSwitchStore(store.dir);
  const intent = pending.consume();
  if (intent === null) return null;

  /**
   * Put the intent back when the switch did not happen for a reason that might
   * not hold next time.
   *
   * `consume()` deletes before the attempt, which is what makes acting on it
   * twice impossible — but it also means a lock timeout or a transient
   * filesystem error would silently discard a handover that was still wanted,
   * and the operator would keep starting sessions on the exhausted account with
   * nothing explaining why.
   *
   * Re-recorded with the ORIGINAL `decidedAt`, so the expiry does not creep
   * forward on every retry. An intent that has genuinely gone stale still dies.
   */
  const restore = (): void => {
    pending.record({
      slot: intent.slot,
      reason: intent.reason,
      decidedAt: intent.decidedAt,
      expiresAt: intent.expiresAt,
      fromHeadroomPct: intent.fromHeadroomPct,
      window: intent.window,
      dryRun: intent.dryRun,
    });
  };

  try {
    const manager = managerFor(config);
    if (!manager.hasAccounts()) return null;

    const resolved = resolveIdentifier(manager.roster.read(), String(intent.slot));
    if (resolved.kind !== 'found') {
      logger.warn('pending handover names a slot that is no longer in the roster', {
        slot: intent.slot,
      });
      return null;
    }

    // Already there — someone switched by hand, or a previous start applied it.
    const detected = await manager.detectActiveSlot();
    if (detected.slot === intent.slot) {
      logger.info('pending handover was already satisfied', { slot: intent.slot });
      return null;
    }

    const result = await switchAccount({
      roster: manager.roster,
      credentials: manager.credentials,
      target: resolved.slot,
    });
    for (const warning of result.warnings) logger.warn(`handover: ${warning}`);

    if (!result.ok) {
      // A failed switch that was rolled back leaves the machine where it was,
      // so the intent is still valid and worth another try at the next start.
      // A failure that could NOT be rolled back is a different matter: the
      // machine may already be on the target, and re-queuing would send the
      // next session somewhere it has possibly already been.
      if (result.rolledBack !== false) restore();
      logger.error('pending handover failed; this session keeps the previous account', {
        detail: result.detail,
        requeued: result.rolledBack !== false,
      });
      return `rotorcc: could not switch account for this session — ${result.detail}`;
    }

    logger.info('handed over to a fresh account at session start', {
      slot: intent.slot,
      reason: intent.reason,
    });
    return (
      `rotorcc: this session opened on slot ${intent.slot} — ${intent.reason} ` +
      '(switched before the session started, so nothing was interrupted)'
    );
  } catch (err) {
    // Nothing here established that the switch happened, so the intent is still
    // wanted. Put it back rather than losing it to an exception.
    restore();
    logger.error('pending handover threw; re-queued for the next session', {
      detail: String(err).slice(0, 200),
    });
    return null;
  }
}

function resumeContext(store: Store): string | null {
  const state = store.readState();
  const manifestPath = store.latestManifest();
  if (manifestPath === null) return null;

  let manifest;
  try {
    manifest = parseManifest(JSON.parse(readFileSync(manifestPath, 'utf8')));
  } catch {
    return null;
  }
  if (manifest.cleanExit) return null;

  // Only speak up about a manifest that is actually recent. A three-week-old
  // unclean exit is history, not a handover.
  const ageHours = (Date.now() - Date.parse(manifest.createdAt)) / 3_600_000;
  if (!Number.isFinite(ageHours) || ageHours > 48) return null;

  const alreadyResumed = state.cleanExits.some((exit) => exit.at > manifest.createdAt);
  if (alreadyResumed) return null;

  const markdown = manifestPath.replace(/\.json$/, '.md');
  const unpushed = manifest.projects
    .flatMap((p) => p.trees)
    .filter((t) => t.checkpoint?.pushed !== true && ((t.ahead ?? 0) > 0 || t.dirtyFiles > 0));

  return [
    '<rotorcc-resume>',
    `The previous session (${manifest.trigger}, ${manifest.createdAt}) did not end cleanly.`,
    `rotorcc rescued what it could and wrote a resume plan: ${markdown}`,
    '',
    unpushed.length > 0
      ? `${unpushed.length} tree(s) still hold work rotorcc could not push. They are listed in the manifest.`
      : 'Every lane rotorcc is allowed to touch was committed and pushed before the session ended.',
    '',
    'Read the manifest before starting anything. Nothing in it needs re-deriving.',
    '</rotorcc-resume>',
  ].join('\n');
}

/**
 * Re-invoke ourselves detached, so the tool loop is not waiting on a git push
 * over a slow network.
 *
 * The payload goes through a file, not a pipe. That looks like the fussier
 * option and is the opposite: a parent cannot exit until its child's stdin pipe
 * has been drained, so piping couples the hook's latency to how fast the child
 * boots — measured at 3.4 seconds on a loaded machine, inside a tool loop with
 * a two-second budget. Writing a small file and handing over the path costs
 * about a millisecond and decouples the two completely.
 */
function detachHeavyWork(
  event: string,
  payloadText: string,
  configPath: string | undefined,
  store: Store,
): void {
  const args = [process.argv[1] ?? '', 'hook', event, '--inline'];
  if (configPath !== undefined) args.push('--config', configPath);
  try {
    const relative = join('pending', `${Date.now()}-${process.pid}-${event}.json`);
    const payloadPath = store.writeAtomic(relative, payloadText);
    args.push('--payload-file', payloadPath);
    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
  } catch {
    /* if the child cannot start, the next hook or daemon tick still covers it */
  }
}

function readPayloadFile(path: string): string {
  try {
    const text = readFileSync(path, 'utf8');
    // Consume it: a pending payload left on disk would be reprocessed by
    // nothing, but it would accumulate, and stale state is its own bug.
    try {
      unlinkSync(path);
    } catch {
      /* another run got there first */
    }
    return text;
  } catch {
    return '';
  }
}

export async function runHook(options: HookOptions): Promise<HookResult> {
  const payloadText =
    options.payloadText ??
    (options.payloadFile !== undefined && options.payloadFile !== ''
      ? readPayloadFile(options.payloadFile)
      : readStdin());
  const parsed = parseHookPayload(payloadText, options.event);

  let config: Config;
  try {
    config = loadConfig(options.configPath);
  } catch {
    // Not configured on this machine: do nothing, say nothing, block nothing.
    return { exitCode: 0, stdout: null };
  }

  const paths = appPaths();
  const store = new Store(paths.stateDir);
  const logger = new Logger({
    file: config.logging.file === '' ? paths.logFile : config.logging.file,
    level: config.logging.level,
    maxBytes: config.logging.maxBytes,
  });

  if (!parsed.ok) {
    logger.warn('hook payload could not be read', { event: options.event, detail: parsed.detail });
    return { exitCode: 0, stdout: null };
  }
  const { payload, event } = parsed;

  if (options.inline === true) {
    await runHeavyWork(config, store, logger, event, payload);
    return { exitCode: 0, stdout: null };
  }

  recordTasks(store, payload);

  // --- the synchronous half: small reads only ---------------------------
  let additionalContext: string | undefined;
  let systemMessage: string | undefined;

  // SessionStart is where rotation is SUPPOSED to happen.
  //
  // The account a session runs on is fixed the moment the process launches, so
  // the only place a switch costs nothing is before that. Doing it here means:
  // no interruption of live work, no successor process, and no way to end up
  // with two sessions on one worktree — which is what the old
  // checkpoint-switch-and-spawn model produced on 2026-08-19.
  //
  // It runs synchronously and before anything else in the hook, because by the
  // time the detached half runs the session has already read its credential.
  if (event === 'SessionStart') {
    const applied = await applyPendingSwitch(config, store, logger);
    if (applied !== null) systemMessage = applied;
  }

  if (event === 'SessionStart' || event === 'UserPromptSubmit') {
    const flags = flagContext(store);
    if (flags !== null) {
      additionalContext = flags.additionalContext;
      systemMessage = flags.systemMessage;
    } else if (event === 'SessionStart') {
      const resume = resumeContext(store);
      if (resume !== null) {
        additionalContext = resume;
        systemMessage = 'rotorcc: the previous session did not end cleanly; resume plan attached';
      }
    }
  }

  if (event === 'SessionEnd') {
    const state = store.readState();
    const sessionId = payload.session_id ?? 'unknown';
    store.writeState({
      ...state,
      cleanExits: [{ sessionId, at: new Date().toISOString() }, ...state.cleanExits].slice(0, 20),
    });
    // A rotation that has completed should not keep shouting at the next
    // session that starts in this directory.
    store.clearFlag(FLAG_ROTATE_NOW);
  }

  // --- the asynchronous half: detached, never awaited --------------------
  const wantsWork = CHECKPOINT_EVENTS.has(event) || SNAPSHOT_ONLY_EVENTS.has(event);
  if (wantsWork && !debounced(store, config, event)) {
    markCheckpointed(store);
    detachHeavyWork(event, payloadText, options.configPath, store);
  }

  const response = renderHookResponse(event, {
    ...(additionalContext !== undefined ? { additionalContext } : {}),
    ...(systemMessage !== undefined ? { systemMessage } : {}),
  });
  return { exitCode: 0, stdout: response };
}

async function runHeavyWork(
  config: Config,
  store: Store,
  logger: Logger,
  event: string,
  payload: HookPayload,
): Promise<void> {
  if (!store.acquireLock('checkpoint', 900)) {
    logger.debug('checkpoint already running; hook deferred', { event });
    return;
  }
  try {
    const snapshotOnly = SNAPSHOT_ONLY_EVENTS.has(event);
    const result = await performCheckpoint({
      config,
      store,
      logger,
      trigger: `hook:${event}`,
      dryRun: config.dryRun,
      writeManifest: event === 'SessionEnd',
      cleanExit: event === 'SessionEnd',
      skipLanes: snapshotOnly,
      // Only the session's end commits an agent's uncommitted edits — that is
      // the moment they would otherwise be lost. Every other event pushes what
      // agents have already committed and leaves their working trees alone.
      commitDirty: event === 'SessionEnd',
      // The local copy is what protects the work. The off-machine mirror is a
      // backup of a backup, and it is left to the scheduled tick so that a slow
      // or full target can never stall a checkpoint behind it.
      skipMirror: true,
      session: {
        id: payload.session_id ?? null,
        transcriptPath: payload.transcript_path ?? null,
        cwd: payload.cwd ?? null,
        backgroundTasks: payload.background_tasks ?? [],
        lastAssistantMessage: payload.last_assistant_message ?? null,
      },
    });
    const state = store.readState();
    store.writeState({
      ...state,
      lastSnapshotAt: new Date().toISOString(),
      ...(result.manifestPath !== null ? { lastManifestPath: result.manifestPath } : {}),
    });
  } catch (err) {
    logger.error('hook checkpoint failed', { event, detail: String(err).slice(0, 400) });
  } finally {
    store.releaseLock('checkpoint');
  }
}

/** Where the state directory lives, for commands that need it. */
export function storeFor(): Store {
  return new Store(appPaths().stateDir);
}

export function manifestMarkdownPath(store: Store): string | null {
  const latest = store.latestManifest();
  return latest === null ? null : join(latest.replace(/\.json$/, '.md'));
}
