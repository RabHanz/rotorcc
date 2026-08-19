/**
 * Colour, decided once.
 *
 * Three constraints shaped this, and they rule out most of what a terminal UI
 * normally does:
 *
 *   1. **It has to work over SSH**, which in practice means: no mouse, no
 *      alternate-screen tricks that break on reconnect, no querying the
 *      terminal for its background colour and waiting for a reply that may
 *      never come. A colour scheme that hangs for two seconds on a flaky link
 *      is worse than no colour.
 *
 *   2. **It has to be readable on a light background and a dark one.** The way
 *      to get that is not to detect the background — it is to use the
 *      terminal's own sixteen colours and let the user's theme decide what they
 *      look like. Anything in the 256-colour cube is a guess about someone
 *      else's palette; `red` is red in every theme ever shipped.
 *
 *   3. **`NO_COLOR` is honoured**, along with a non-TTY stdout and `TERM=dumb`.
 *      A dashboard piped into a file should be a dashboard, not escape codes.
 *
 * There is deliberately no bright white and no pure black anywhere: those are
 * the two colours that vanish on one theme or the other.
 */
export type ThemeMode = 'auto' | 'dark' | 'light' | 'none';

export interface Palette {
  reset: string;
  bold: (s: string) => string;
  dim: (s: string) => string;
  /** Healthy, plenty of headroom. */
  good: (s: string) => string;
  /** Worth watching. */
  warn: (s: string) => string;
  /** Bad, or about to be. */
  bad: (s: string) => string;
  /**
   * UNKNOWN. Its own colour on purpose, and never the same as `good` or `bad`,
   * because the whole discipline of this tool is that unknown is a third thing.
   */
  unknown: (s: string) => string;
  accent: (s: string) => string;
  enabled: boolean;
}

const IDENTITY = (s: string): string => s;

function wrap(open: string): (s: string) => string {
  return (s: string) => `[${open}m${s}[0m`;
}

export interface ColourDecision {
  enabled: boolean;
  /** Why, so `doctor` can explain a dashboard that came out monochrome. */
  reason: string;
}

export function shouldColour(
  mode: ThemeMode,
  options: { env?: NodeJS.ProcessEnv; isTTY?: boolean } = {},
): ColourDecision {
  const env = options.env ?? process.env;
  if (mode === 'none') return { enabled: false, reason: 'theme is set to "none"' };
  // The NO_COLOR convention: set at all, to anything including empty, means off.
  if (env.NO_COLOR !== undefined) return { enabled: false, reason: 'NO_COLOR is set' };
  if (env.TERM === 'dumb') return { enabled: false, reason: 'TERM=dumb' };
  const isTTY = options.isTTY ?? process.stdout.isTTY === true;
  if (!isTTY) return { enabled: false, reason: 'stdout is not a terminal' };
  return { enabled: true, reason: `theme "${mode}"` };
}

export function palette(
  mode: ThemeMode = 'auto',
  options: { env?: NodeJS.ProcessEnv; isTTY?: boolean } = {},
): Palette {
  const decision = shouldColour(mode, options);
  if (!decision.enabled) {
    return {
      reset: '',
      bold: IDENTITY,
      dim: IDENTITY,
      good: IDENTITY,
      warn: IDENTITY,
      bad: IDENTITY,
      unknown: IDENTITY,
      accent: IDENTITY,
      enabled: false,
    };
  }
  return {
    reset: '[0m',
    bold: wrap('1'),
    dim: wrap('2'),
    good: wrap('32'),
    warn: wrap('33'),
    bad: wrap('31'),
    // Magenta for unknown. Distinct from every health colour at a glance, and
    // legible on both light and dark terminals, which cyan on white is not.
    unknown: wrap('35'),
    accent: wrap('36'),
    enabled: true,
  };
}

/**
 * The visible width of a string, ignoring ANSI escapes.
 *
 * Padding a coloured string with `padEnd` counts the escape bytes and produces
 * a column that is eight characters short. Every alignment in the renderer goes
 * through here instead.
 */
export function visibleWidth(value: string): number {
  // eslint-disable-next-line no-control-regex
  return value.replace(/\[[0-9;]*m/g, '').length;
}

export function padVisible(value: string, width: number): string {
  const pad = Math.max(0, width - visibleWidth(value));
  return value + ' '.repeat(pad);
}

export function truncateVisible(value: string, width: number): string {
  if (visibleWidth(value) <= width) return value;
  // Truncating a coloured string can cut an escape sequence in half and leave
  // the terminal stuck in that colour for the rest of the session. Strip first.
  // eslint-disable-next-line no-control-regex
  const plain = value.replace(/\[[0-9;]*m/g, '');
  return width <= 1 ? plain.slice(0, width) : `${plain.slice(0, width - 1)}…`;
}
