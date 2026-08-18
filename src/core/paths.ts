/**
 * Where rotorcc keeps its config, state and transcript store on each platform.
 *
 * Linux and the BSDs follow the XDG base-directory spec. macOS uses the same
 * XDG layout on purpose rather than `~/Library/Application Support`: the store
 * is a git repository an operator will want to `cd` into and inspect, and a
 * path with a space in it makes every shell example in the README worse.
 * Windows uses the standard APPDATA / LOCALAPPDATA split.
 */
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
    logFile: join(stateDir, 'rotorcc.log'),
    claudeHome,
  };
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
