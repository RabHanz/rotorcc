/**
 * Where rotorcc keeps its config, state and transcript store on each platform.
 *
 * Linux and the BSDs follow the XDG base-directory spec. macOS uses the same
 * XDG layout on purpose rather than `~/Library/Application Support`: the store
 * is a git repository an operator will want to `cd` into and inspect, and a
 * path with a space in it makes every shell example in the README worse.
 * Windows uses the standard APPDATA / LOCALAPPDATA split.
 */
import { existsSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

export type Platform = 'linux' | 'darwin' | 'win32' | 'other';

export function currentPlatform(env: NodeJS.ProcessEnv = process.env): Platform {
  const p = platform();
  if (p === 'linux' || p === 'darwin' || p === 'win32') {
    // WSL reports linux, which is what we want: it has systemd-or-not, a real
    // filesystem and a real tmux. `isWsl` only changes advisory messages.
    void env;
    return p;
  }
  return 'other';
}

export function isWsl(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.WSL_DISTRO_NAME ?? env.WSL_INTEROP);
}

export interface AppPaths {
  /** Directory holding config.json. */
  configDir: string;
  /** The config file itself. */
  configFile: string;
  /** Durable, machine-local state: latches, flags, manifests. */
  stateDir: string;
  /** Default transcript store (a git repository rotorcc owns). */
  dataDir: string;
  /**
   * Where rotorcc keeps the accounts it manages: the roster, each account's
   * stashed credential and config, the usage cache and the directory mappings.
   *
   * Deliberately NOT the transcript store. The store is a git repository an
   * operator inspects, diffs and may mirror off the machine; account
   * credentials must never be in something with that shape.
   */
  accountsDir: string;
  /** Default log file. */
  logFile: string;
  /** The user's Claude Code home, where transcripts already live. */
  claudeHome: string;
}

function windowsBase(env: NodeJS.ProcessEnv, home: string): { roaming: string; local: string } {
  return {
    roaming: env.APPDATA ?? join(home, 'AppData', 'Roaming'),
    local: env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'),
  };
}

export function appPaths(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  plat: Platform = currentPlatform(env),
): AppPaths {
  const claudeHome = env.CLAUDE_CONFIG_DIR ?? join(home, '.claude');

  if (plat === 'win32') {
    const { roaming, local } = windowsBase(env, home);
    const configDir = join(roaming, 'rotorcc');
    const stateDir = join(local, 'rotorcc', 'state');
    const dataDir = join(local, 'rotorcc', 'store');
    return {
      configDir,
      configFile: join(configDir, 'config.json'),
      stateDir,
      dataDir,
      accountsDir: join(local, 'rotorcc', 'accounts'),
      logFile: join(local, 'rotorcc', 'rotorcc.log'),
      claudeHome,
    };
  }

  const xdgConfig = env.XDG_CONFIG_HOME ?? join(home, '.config');
  const xdgState = env.XDG_STATE_HOME ?? join(home, '.local', 'state');
  const xdgData = env.XDG_DATA_HOME ?? join(home, '.local', 'share');
  const configDir = join(xdgConfig, 'rotorcc');
  const stateDir = join(xdgState, 'rotorcc');
  return {
    configDir,
    configFile: join(configDir, 'config.json'),
    stateDir,
    dataDir: join(xdgData, 'rotorcc', 'store'),
    accountsDir: join(xdgData, 'rotorcc', 'accounts'),
    logFile: join(stateDir, 'rotorcc.log'),
    claudeHome,
  };
}

/**
 * Claude Code's own config home: `CLAUDE_CONFIG_DIR` when set, else `~/.claude`.
 *
 * rotorcc reads and writes the same files Claude Code does, so this has to
 * agree with Claude Code's resolution exactly. Getting it wrong does not throw
 * — it silently reads a credential that is not the live one, which is the
 * worst failure mode this tool has.
 */
export function claudeConfigHome(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const explicit = env.CLAUDE_CONFIG_DIR;
  return explicit !== undefined && explicit !== '' ? explicit : join(home, '.claude');
}

/**
 * Claude Code's global config file.
 *
 * Note the asymmetry, which is Claude Code's and not ours: the legacy
 * `<config-home>/.config.json` wins when it exists, otherwise the file lives at
 * `(CLAUDE_CONFIG_DIR || $HOME)/.claude.json` — beside the home directory, not
 * inside `.claude/`. `existsSync` is checked at call time, because a machine
 * can gain or lose the legacy file between two rotorcc invocations.
 */
export function claudeGlobalConfigPath(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  fileExists: (path: string) => boolean = existsSync,
): string {
  const legacy = join(claudeConfigHome(env, home), '.config.json');
  if (fileExists(legacy)) return legacy;
  const explicit = env.CLAUDE_CONFIG_DIR;
  const base = explicit !== undefined && explicit !== '' ? explicit : home;
  return join(base, '.claude.json');
}

/** Claude Code's plaintext OAuth credential file. */
export function claudeCredentialsPath(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  return join(claudeConfigHome(env, home), '.credentials.json');
}

/**
 * Claude Code's project-directory slug: every character that is not a letter or
 * a digit becomes a dash, so `/home/u/proj` becomes `-home-u-proj` and
 * `/home/u/proj/.claude/worktrees/x` becomes `-home-u-proj--claude-worktrees-x`.
 *
 * Confirmed against real `transcript_path` values from live hook payloads
 * rather than inferred; see test/fixtures/hook-payloads.
 */
export function projectSlug(projectPath: string): string {
  return projectPath.replace(/[^a-zA-Z0-9]/g, '-');
}
