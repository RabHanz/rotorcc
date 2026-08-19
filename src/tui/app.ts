/**
 * The live dashboard loop.
 *
 * Deliberately small and deliberately boring, because the interesting parts are
 * `model.ts` (gathering) and `render.ts` (pure). What is left here is terminal
 * mechanics, and those have exactly three requirements:
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
 *   - **Work over SSH.** No mouse reporting, no terminal capability queries, no
 *     waiting for a reply the far end may never send. Resize is handled through
 *     the `resize` event, which works everywhere.
 *
 * `--once` renders a single frame and exits, which is what makes the dashboard
 * usable in a script, a cron mail, or a pipe.
 */
import { buildDashboardModel, type BuildModelOptions } from './model.js';
import { footer, renderDashboard } from './render.js';
import { type ThemeMode, palette } from './theme.js';
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
}

const ALT_SCREEN_ON = '[?1049h';
const ALT_SCREEN_OFF = '[?1049l';
const CURSOR_HIDE = '[?25l';
const CURSOR_SHOW = '[?25h';
const CLEAR_HOME = '[H[2J';

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

export async function runTui(options: TuiOptions): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const stdin = options.stdin ?? process.stdin;

  if (options.once === true || stdout.isTTY !== true) {
    // Not a terminal: one frame, plain, to whatever this is being piped into.
    // Taking over a pipe with escape codes would be actively unhelpful.
    stdout.write(await renderOnce(options));
    return 0;
  }

  const redrawMs = options.redrawMs ?? 1_000;
  const gatherMs = options.gatherMs ?? 15_000;

  let running = true;
  let paused = false;
  let gathering = false;
  let forceNext = options.force ?? false;
  let previousWorkload: WorkloadSnapshot | null = null;
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
      { ...model, now: new Date(), refreshing: gathering },
      { palette: colours, width: stdout.columns ?? 100, height },
    );
    // Trim to the window rather than letting the terminal scroll: a dashboard
    // that scrolls is a log, and the header disappearing is the header you
    // needed.
    const body = lines.slice(0, Math.max(1, height - 2));
    stdout.write(`${CLEAR_HOME}${body.join('\n')}\n\n${footer(colours, paused)}`);
  };

  const gather = async (): Promise<void> => {
    if (gathering || paused) return;
    gathering = true;
    try {
      model = await buildDashboardModel({
        ...options,
        force: forceNext,
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
    }
  };

  if (stdin.isTTY === true) {
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    stdin.on('data', (key: string) => {
      // Ctrl-C and Ctrl-D. In raw mode the signal is not delivered for us.
      if (key === '' || key === '' || key === 'q') {
        running = false;
        return;
      }
      if (key === 'r') {
        forceNext = true;
        void gather();
        return;
      }
      if (key === 'p') paused = !paused;
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
