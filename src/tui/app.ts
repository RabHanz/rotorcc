/**
 * The live dashboard loop.
 *
 * Terminal mechanics and scheduling live here; `model.ts` gathers, `render.ts`
 * draws, and `interaction.ts` decides what a key means. Four requirements shape
 * this file:
 *
 *   - **Leave the terminal as we found it.** Raw mode off, cursor visible,
 *     alternate screen exited — on `q`, on Ctrl-C, on SIGTERM, and on an
 *     exception. A dashboard that leaves an invisible cursor behind is a
 *     dashboard nobody runs twice.
 *
 *   - **Never block on the network.** The redraw runs on a fast timer and the
 *     gather runs on a slow one, independently. If a quota fetch takes eight
 *     seconds the clock still ticks and the last-known numbers stay on screen,
 *     with their age, which is the honest presentation anyway.
 *
 *   - **Never block on an action either.** A switch takes locks and writes
 *     files. It runs off the draw loop, the header says it is running, and the
 *     result lands in the pane — an action whose outcome you have to leave the
 *     pane to discover is only half-built.
 *
 *   - **Work over SSH.** No mouse reporting, no terminal capability queries, no
 *     waiting for a reply the far end may never send. Resize is handled through
 *     the `resize` event, which works everywhere.
 *
 * `--once`, and any run whose stdout is not a terminal, render a single
 * read-only frame. There is no cursor and no key handling on a pipe, and a
 * frame going into a cron mail must not be able to switch an account.
 */
import type { Config } from '../config/schema.js';
import type { Logger } from '../core/log.js';
import { type ActionContext, runAction } from './actions.js';
import {
  type KeyAccount,
  type KeyContext,
  type UiState,
  applyOutcome,
  handleKey,
  initialUiState,
} from './interaction.js';
import { buildDashboardModel, type BuildModelOptions } from './model.js';
import { type DashboardModel, footer, renderDashboard } from './render.js';
import { type ThemeMode, palette } from './theme.js';
import { formatBinding, formatWindowsUsed } from '../core/usage.js';
import type { WorkloadSnapshot } from '../core/workload.js';

export interface TuiOptions extends BuildModelOptions {
  theme?: ThemeMode;
  /** Redraw interval. The clock and spinner move at this rate. */
  redrawMs?: number;
  /** Gather interval. Quota, worktrees and journal are re-read at this rate. */
  gatherMs?: number;
  /** Render one frame and return, instead of taking over the terminal. */
  once?: boolean;
  stdout?: NodeJS.WriteStream;
  stdin?: NodeJS.ReadStream;
  /** Needed by the acting keys; they log exactly as the CLI verbs do. */
  logger: Logger;
  /** The config file the strategy picker writes back to. */
  configPath?: string | undefined;
}

const ALT_SCREEN_ON = '[?1049h';
const ALT_SCREEN_OFF = '[?1049l';
const CURSOR_HIDE = '[?25l';
const CURSOR_SHOW = '[?25h';
const CLEAR_HOME = '[H[2J';

/**
 * Key sequences that are one key even though they are several bytes.
 *
 * Anything else longer than a single character is ignored rather than replayed
 * character by character: a paste into a pane where `d` disables an account and
 * `enter` confirms is not an input method, it is an accident waiting to happen.
 */
const MULTI_BYTE_KEYS = new Set([
  '\u001b[A',
  '\u001b[B',
  '\u001b[C',
  '\u001b[D',
  '\u001bOA',
  '\u001bOB',
  '\u001bOC',
  '\u001bOD',
]);

export function normaliseKey(chunk: string): string | null {
  if (chunk.length === 1) return chunk;
  if (MULTI_BYTE_KEYS.has(chunk)) return chunk;
  return null;
}

/** Render one frame to a string. Used by `--once` and by the tests. */
export async function renderOnce(options: TuiOptions): Promise<string> {
  const stdout = options.stdout ?? process.stdout;
  const model = await buildDashboardModel(options);
  const colours = palette(options.theme ?? 'auto', { isTTY: stdout.isTTY === true });
  const lines = renderDashboard(model, {
    palette: colours,
    width: stdout.columns ?? 100,
  });
  return `${lines.join('\n')}\n`;
}

/** The facts `interaction.ts` needs about the world, derived from the model. */
export function keyContextFor(model: DashboardModel, config: Config, dryRun: boolean): KeyContext {
  const accounts: KeyAccount[] = (model.usage?.accounts ?? []).map((account) => ({
    slot: account.number,
    label: account.alias ?? account.email ?? `account ${account.number}`,
    disabled: account.disabled === true,
    active: account.active,
    // Both windows go into the confirmation, because a slot number is not
    // something anybody can make a decision from.
    windows: formatWindowsUsed(account),
    binding: formatBinding(account),
  }));
  return {
    accounts,
    strategy: config.strategy,
    dryRun,
    flagsRaised: model.raisedFlags.length > 0,
  };
}

export async function runTui(options: TuiOptions): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const stdin = options.stdin ?? process.stdin;

  if (options.once === true || stdout.isTTY !== true) {
    // Not a terminal: one frame, plain, to whatever this is being piped into.
    // Taking over a pipe with escape codes would be actively unhelpful, and
    // handing it a control surface would be worse.
    stdout.write(await renderOnce(options));
    return 0;
  }

  const redrawMs = options.redrawMs ?? 1_000;
  const gatherMs = options.gatherMs ?? 15_000;

  let running = true;
  let gathering = false;
  let forceNext = options.force ?? false;
  let config = options.config;
  let previousWorkload: WorkloadSnapshot | null = null;
  let ui: UiState = initialUiState();
  let model = await buildDashboardModel({ ...options, force: forceNext });
  previousWorkload = model.workload;
  forceNext = false;

  const colours = palette(options.theme ?? 'auto', { isTTY: true });

  // Restoration is registered before the terminal is modified, so a throw
  // between here and the first draw still puts the terminal back.
  let restored = false;
  const restore = (): void => {
    if (restored) return;
    restored = true;
    try {
      if (stdin.isTTY === true) stdin.setRawMode(false);
    } catch {
      /* the terminal is gone; nothing to restore it to */
    }
    stdout.write(`${CURSOR_SHOW}${ALT_SCREEN_OFF}`);
  };
  process.on('exit', restore);

  stdout.write(`${ALT_SCREEN_ON}${CURSOR_HIDE}`);

  const draw = (): void => {
    const height = stdout.rows ?? 40;
    const lines = renderDashboard(
      { ...model, now: new Date(), refreshing: gathering, strategy: config.strategy },
      { palette: colours, width: stdout.columns ?? 100, height, ui },
    );
    // Trim to the window rather than letting the terminal scroll: a dashboard
    // that scrolls is a log, and the header disappearing is the header you
    // needed.
    const body = lines.slice(0, Math.max(1, height - 2));
    stdout.write(`${CLEAR_HOME}${body.join('\n')}\n\n${footer(colours, { paused: ui.paused })}`);
  };

  /**
   * `ignorePause` and `force` are deliberately separate.
   *
   * `r` means "read the machine again now" and must not spend a quota request
   * per keypress; `f` means "poll the provider, ignoring the floor". Folding
   * them into one flag turned an idle operator holding `r` into a rate-limit
   * incident of their own making.
   */
  const gather = async (opts: { ignorePause?: boolean; force?: boolean } = {}): Promise<void> => {
    if (gathering || (ui.paused && opts.ignorePause !== true)) return;
    gathering = true;
    try {
      model = await buildDashboardModel({
        ...options,
        config,
        force: opts.force === true || forceNext,
        previousWorkload,
      });
      previousWorkload = model.workload;
      forceNext = false;
    } catch {
      // A failed gather keeps the previous model on screen. Its ages keep
      // climbing, which is exactly the signal that something has stopped
      // working — better than a blank panel that says nothing.
    } finally {
      gathering = false;
      draw();
    }
  };

  const actionContext = (): ActionContext => ({
    config,
    store: options.store,
    manager: options.manager,
    logger: options.logger,
    dryRun: options.dryRun,
    configPath: options.configPath,
  });

  const perform = async (action: Parameters<typeof runAction>[1]): Promise<void> => {
    const outcome = await runAction(actionContext(), action);
    if (action.kind === 'set-strategy' && outcome.ok && action.strategy !== undefined) {
      // Keep the pane truthful about what it just changed. The file is the
      // source of truth; this is the in-memory copy catching up so the header
      // and the next confirmation do not quote the old rule.
      config = { ...config, strategy: action.strategy };
    }
    ui = applyOutcome(ui, outcome);
    draw();
    // The world moved: re-read it rather than leaving numbers on screen that
    // describe the machine as it was before the action.
    await gather({ ignorePause: true });
  };

  if (stdin.isTTY === true) {
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    stdin.on('data', (chunk: string) => {
      const key = normaliseKey(chunk);
      if (key === null) return;
      const result = handleKey(key, ui, keyContextFor(model, config, options.dryRun));
      ui = result.state;
      switch (result.intent.kind) {
        case 'quit':
          running = false;
          break;
        case 'gather':
          void gather({ ignorePause: true, force: result.intent.force });
          break;
        case 'run':
          void perform(result.intent.action);
          break;
        case 'none':
          break;
      }
      draw();
    });
  }

  const onResize = (): void => draw();
  stdout.on('resize', onResize);

  const redrawTimer = setInterval(draw, redrawMs);
  const gatherTimer = setInterval(() => void gather(), gatherMs);
  const onSignal = (): void => {
    running = false;
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  draw();

  try {
    // Poll for the quit flag rather than racing promises: one place decides
    // the loop is over, and the cleanup below always runs.
    while (running) {
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
  } finally {
    clearInterval(redrawTimer);
    clearInterval(gatherTimer);
    stdout.off('resize', onResize);
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    if (stdin.isTTY === true) stdin.pause();
    restore();
  }
  return 0;
}
