/**
 * Starting the replacement session.
 *
 * The mechanism, verified against a live Claude Code 2.1.x rather than assumed:
 *
 *   - `claude --continue "<prompt>"` in an interactive terminal restores the
 *     previous conversation AND submits the prompt on its own. No send-keys
 *     needed in the normal case.
 *   - A directory the CLI has not been trusted in first shows a trust dialog
 *     and waits. rotorcc detects that and says so; it does not answer it.
 *     Trusting a directory is the operator's decision, not a rotation step.
 *   - `--continue` fails with "No conversation found to continue" when the
 *     directory has no prior session. That is reported, not retried blindly.
 *
 * There is no supported way to make one process pick up another's credentials,
 * so a new process is the only rotation there is. That is the honest shape of
 * the problem, and this module does not pretend otherwise.
 */
import type { Config } from '../config/schema.js';
import type { Logger } from './log.js';
import { run } from './proc.js';

export interface LaunchContext {
  config: Config;
  logger: Logger;
  cwd: string;
  prompt: string;
  dryRun: boolean;
  /**
   * Terminal target the predecessor is running in, when it was identifiable.
   * The successor opens beside it, because that is the window the operator is
   * already looking at.
   */
  preferTarget?: string | undefined;
}

export interface LaunchResult {
  ok: boolean;
  launcher: string;
  detail: string;
  /** Terminal target the successor was opened in, for later retirement. */
  handle: string | null;
  /** The prompt was seen echoed in the successor's terminal. */
  promptConfirmed: boolean;
  warnings: string[];
}

export function renderCommand(template: string[], prompt: string): string[] {
  return template.map((part) => part.replace(/\{\{prompt\}\}/g, prompt));
}

const TRUST_DIALOG = /trust this folder|Do you trust the files/i;
const NO_CONVERSATION = /No conversation found to continue/i;

async function tmux(config: Config, args: string[], timeoutMs = 20_000) {
  return run([...config.commands.tmux, ...args], { timeoutMs, okCodes: [1] });
}

/**
 * Which tmux session to open the successor in, in order of preference:
 *
 *   1. the predecessor's own session — the operator is already looking at it;
 *   2. an attached session — somebody is looking at that one;
 *   3. the first session that exists.
 *
 * The predecessor's session matters more than "attached" and this is why: on a
 * machine where the terminal has been detached (a closed laptop lid, a
 * disconnected editor), nothing is attached, and picking the first session by
 * name drops the replacement into whatever happens to sort first — measured
 * here as an unrelated scratch session the operator never opens.
 */
export async function pickTmuxSession(
  config: Config,
  preferTarget?: string | undefined,
): Promise<string | null> {
  const preferred = preferTarget?.split(':')[0];
  const listed = await tmux(config, [
    'list-sessions',
    '-F',
    '#{session_name}\t#{?session_attached,attached,detached}',
  ]);
  if (listed.stdout.trim() === '') return null;
  const rows = listed.stdout
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '')
    .map((l) => {
      const [name = '', state = ''] = l.split('\t');
      return { name, attached: state === 'attached' };
    });
  if (preferred !== undefined && preferred !== '' && rows.some((r) => r.name === preferred)) {
    return preferred;
  }
  return rows.find((r) => r.attached)?.name ?? rows[0]?.name ?? null;
}

async function capture(config: Config, target: string): Promise<string> {
  const result = await tmux(config, ['capture-pane', '-p', '-t', target]);
  return result.stdout;
}

async function launchTmux(ctx: LaunchContext): Promise<LaunchResult> {
  const { config, logger } = ctx;
  const warnings: string[] = [];
  const argv = renderCommand(config.successor.command, ctx.prompt);

  let session = config.successor.session;
  if (session === '') {
    session = (await pickTmuxSession(config, ctx.preferTarget)) ?? '';
  }

  if (ctx.dryRun) {
    return {
      ok: true,
      launcher: 'tmux',
      detail: `dry run: would open window "${config.successor.windowName}" in ${session === '' ? 'a new session' : session} running ${argv.join(' ')}`,
      handle: null,
      promptConfirmed: false,
      warnings,
    };
  }

  let handle: string;
  if (session === '') {
    session = 'rotorcc';
    const created = await tmux(config, [
      'new-session',
      '-d',
      '-s',
      session,
      '-n',
      config.successor.windowName,
      '-c',
      ctx.cwd,
      ...argv,
    ]);
    if (!created.ok) {
      return {
        ok: false,
        launcher: 'tmux',
        detail: `could not create a tmux session: ${created.error ?? created.stderr}`,
        handle: null,
        promptConfirmed: false,
        warnings,
      };
    }
    handle = `${session}:${config.successor.windowName}`;
  } else {
    const created = await tmux(config, [
      'new-window',
      '-t',
      session,
      '-n',
      config.successor.windowName,
      '-c',
      ctx.cwd,
      '-P',
      '-F',
      '#{session_name}:#{window_index}',
      ...argv,
    ]);
    if (!created.ok) {
      return {
        ok: false,
        launcher: 'tmux',
        detail: `could not open a tmux window: ${created.error ?? created.stderr}`,
        handle: null,
        promptConfirmed: false,
        warnings,
      };
    }
    handle = created.stdout.trim() || `${session}:${config.successor.windowName}`;
  }

  logger.info('successor launched', { handle, argv: argv[0] });

  const deadline = Date.now() + config.successor.readyTimeoutSeconds * 1000;
  let promptConfirmed = false;
  const marker = ctx.prompt.slice(0, 40);
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    const pane = await capture(config, handle);
    if (TRUST_DIALOG.test(pane)) {
      warnings.push(
        `${ctx.cwd} has not been trusted in this CLI yet, so the successor is waiting on the ` +
          'trust dialog. rotorcc will not answer it for you. Answer it once by hand and the ' +
          'next rotation will be clean.',
      );
      break;
    }
    if (NO_CONVERSATION.test(pane)) {
      warnings.push(
        `there is no previous conversation in ${ctx.cwd} to continue, so the successor started ` +
          'empty. The manifest still has everything; open it by hand.',
      );
      break;
    }
    if (marker !== '' && pane.includes(marker)) {
      promptConfirmed = true;
      break;
    }
  }

  if (!promptConfirmed && warnings.length === 0 && config.successor.sendKeysFallback) {
    logger.warn('successor did not echo the resume prompt; typing it in', { handle });
    await tmux(config, ['send-keys', '-t', handle, ctx.prompt]);
    await new Promise((r) => setTimeout(r, 500));
    await tmux(config, ['send-keys', '-t', handle, 'Enter']);
    await new Promise((r) => setTimeout(r, 3000));
    promptConfirmed = (await capture(config, handle)).includes(marker);
  }

  for (const warning of warnings) logger.warn(warning, { handle });

  return {
    ok: true,
    launcher: 'tmux',
    detail: `opened ${handle}`,
    handle,
    promptConfirmed,
    warnings,
  };
}

async function launchScreen(ctx: LaunchContext): Promise<LaunchResult> {
  const { config } = ctx;
  const argv = renderCommand(config.successor.command, ctx.prompt);
  const name = config.successor.session === '' ? 'rotorcc' : config.successor.session;
  if (ctx.dryRun) {
    return {
      ok: true,
      launcher: 'screen',
      detail: `dry run: would start screen session ${name} running ${argv.join(' ')}`,
      handle: null,
      promptConfirmed: false,
      warnings: [],
    };
  }
  const result = await run([...config.commands.screen, '-dmS', name, ...argv], {
    cwd: ctx.cwd,
    timeoutMs: 20_000,
  });
  return {
    ok: result.ok,
    launcher: 'screen',
    detail: result.ok ? `started screen session ${name}` : (result.error ?? result.stderr),
    handle: result.ok ? name : null,
    // screen has no reliable, non-intrusive way to read a window back, so the
    // launch is reported as unconfirmed rather than claimed as confirmed.
    promptConfirmed: false,
    warnings: result.ok
      ? ['screen cannot confirm the successor accepted the prompt; check it by hand']
      : [],
  };
}

export async function launchSuccessor(ctx: LaunchContext): Promise<LaunchResult> {
  switch (ctx.config.successor.launcher) {
    case 'tmux':
      return launchTmux(ctx);
    case 'screen':
      return launchScreen(ctx);
    default:
      return {
        ok: true,
        launcher: 'none',
        detail:
          'no successor launcher configured; start the next session by hand and point it at the manifest',
        handle: null,
        promptConfirmed: false,
        warnings: [],
      };
  }
}

/**
 * Close the predecessor's window once it has stopped writing.
 *
 * Killing a window is the only irreversible thing rotorcc does, so it is off by
 * default, it waits for the transcript to go quiet first, and it gives up
 * rather than killing something it cannot positively identify.
 */
export async function retireWindow(
  config: Config,
  logger: Logger,
  handle: string,
  dryRun: boolean,
): Promise<{ killed: boolean; detail: string }> {
  if (!config.retire.killOldWindow) {
    return { killed: false, detail: 'retire.killOldWindow is off; predecessor left running' };
  }
  if (dryRun) return { killed: false, detail: `dry run: would kill ${handle}` };

  const exists = await tmux(config, ['has-session', '-t', handle.split(':')[0] ?? handle]);
  if (!exists.ok) return { killed: false, detail: `no such tmux target: ${handle}` };

  const result = await tmux(config, ['kill-window', '-t', handle]);
  if (!result.ok) return { killed: false, detail: result.error ?? result.stderr };
  logger.info('predecessor window closed', { handle });
  return { killed: true, detail: `killed ${handle}` };
}

/**
 * Find the tmux target running a Claude Code process in `cwd`, so the
 * predecessor can be retired later. Returns null when nothing matches, which
 * is the safe answer.
 */
export async function findWindowForCwd(config: Config, cwd: string): Promise<string | null> {
  const listed = await tmux(config, [
    'list-panes',
    '-a',
    '-F',
    '#{session_name}:#{window_index}\t#{pane_current_path}\t#{pane_current_command}',
  ]);
  if (listed.stdout.trim() === '') return null;
  for (const line of listed.stdout.split(/\r?\n/)) {
    const [target = '', path = '', command = ''] = line.split('\t');
    if (path === cwd && /claude|node/i.test(command)) return target;
  }
  return null;
}
