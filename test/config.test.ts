import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ConfigError,
  defaultConfig,
  expandPath,
  getConfigValue,
  loadConfig,
  parseConfig,
  saveConfig,
  setConfigValue,
} from '../src/config/load.js';
import { appPaths, projectSlug } from '../src/core/paths.js';
import { cleanup, tempDir } from './helpers.js';

describe('parseConfig', () => {
  it('fills in every default from a minimal config', () => {
    const config = parseConfig({
      claudeHome: '/home/dev/.claude',
      storePath: '/home/dev/store',
      projects: [{ path: '/home/dev/project' }],
    });
    expect(config.thresholds).toEqual({ warnPct: 15, softPct: 10, rotatePct: 5 });
    expect(config.pollSeconds).toBe(60);
    expect(config.mirror.type).toBe('none');
    expect(config.projects[0]?.worktreeGlobs).toEqual(['.claude/worktrees/*']);
    expect(config.projects[0]?.protectedBranches).toContain('main');
    expect(config.commands.git).toEqual(['git']);
  });

  it('refuses a config with no projects, because there would be nothing to protect', () => {
    expect(() => parseConfig({ claudeHome: '/a', storePath: '/b', projects: [] })).toThrow(
      ConfigError,
    );
  });

  it('refuses a poll interval that would hammer the usage API', () => {
    expect(() =>
      parseConfig({
        claudeHome: '/a',
        storePath: '/b',
        projects: [{ path: '/c' }],
        pollSeconds: 5,
      }),
    ).toThrow();
  });

  it('refuses a percentage outside 0-100', () => {
    expect(() =>
      parseConfig({
        claudeHome: '/a',
        storePath: '/b',
        projects: [{ path: '/c' }],
        thresholds: { rotatePct: 140 },
      }),
    ).toThrow();
  });

  it('requires a target when a mirror is configured', () => {
    expect(() =>
      parseConfig({
        claudeHome: '/a',
        storePath: '/b',
        projects: [{ path: '/c' }],
        mirror: { type: 'rsync-ssh' },
      }),
    ).toThrow();
  });

  it('expands ~ and relative paths so nothing downstream has to', () => {
    const config = parseConfig(
      {
        claudeHome: '~/.claude',
        storePath: '~/store',
        projects: [{ path: '~/project' }],
      },
      '/home/dev',
    );
    expect(config.claudeHome).toBe('/home/dev/.claude');
    expect(config.projects[0]?.path).toBe('/home/dev/project');
  });
});

describe('loadConfig', () => {
  it('says where to look when there is no config yet', () => {
    const dir = tempDir();
    try {
      expect(() => loadConfig(join(dir, 'nope.json'))).toThrow(/rotorcc init/);
    } finally {
      cleanup(dir);
    }
  });

  it('says the file is not JSON rather than silently using defaults', () => {
    const dir = tempDir();
    try {
      const path = join(dir, 'config.json');
      writeFileSync(path, '{ this is not json');
      expect(() => loadConfig(path)).toThrow(/not valid JSON/);
    } finally {
      cleanup(dir);
    }
  });

  it('round-trips through save and load', () => {
    const dir = tempDir();
    try {
      const path = join(dir, 'nested', 'config.json');
      const config = defaultConfig(['/home/dev/project']);
      saveConfig(config, path);
      expect(loadConfig(path)).toEqual(config);
    } finally {
      cleanup(dir);
    }
  });
});

describe('config get and set', () => {
  const config = defaultConfig(['/home/dev/project']);

  it('reads a dotted key', () => {
    expect(getConfigValue(config, 'thresholds.rotatePct')).toBe(5);
    expect(getConfigValue(config, 'nope.nope')).toBeUndefined();
  });

  it('sets a number, a boolean and a string', () => {
    expect(
      getConfigValue(setConfigValue(config, 'thresholds.rotatePct', '3'), 'thresholds.rotatePct'),
    ).toBe(3);
    expect(getConfigValue(setConfigValue(config, 'dryRun', 'true'), 'dryRun')).toBe(true);
    expect(
      getConfigValue(
        setConfigValue(config, 'successor.windowName', 'next'),
        'successor.windowName',
      ),
    ).toBe('next');
  });

  it('re-validates, so a typo is rejected instead of stored', () => {
    expect(() => setConfigValue(config, 'thresholds.rotatePct', '"five"')).toThrow();
    expect(() => setConfigValue(config, 'pollSeconds', '1')).toThrow();
  });

  it('refuses a key whose container does not exist', () => {
    expect(() => setConfigValue(config, 'nothing.here', '1')).toThrow(ConfigError);
  });
});

describe('paths', () => {
  it('uses XDG directories on Linux', () => {
    const paths = appPaths({ HOME: '/home/dev' }, '/home/dev', 'linux');
    expect(paths.configFile).toBe('/home/dev/.config/rotorcc/config.json');
    expect(paths.stateDir).toBe('/home/dev/.local/state/rotorcc');
    expect(paths.dataDir).toBe('/home/dev/.local/share/rotorcc/store');
  });

  it('honours XDG overrides', () => {
    const paths = appPaths(
      { XDG_CONFIG_HOME: '/cfg', XDG_STATE_HOME: '/st', XDG_DATA_HOME: '/dt' },
      '/home/dev',
      'linux',
    );
    expect(paths.configFile).toBe('/cfg/rotorcc/config.json');
    expect(paths.stateDir).toBe('/st/rotorcc');
  });

  it('uses the AppData split on Windows', () => {
    const paths = appPaths(
      {
        APPDATA: 'C:\\Users\\dev\\AppData\\Roaming',
        LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local',
      },
      'C:\\Users\\dev',
      'win32',
    );
    expect(paths.configFile).toContain('Roaming');
    expect(paths.stateDir).toContain('Local');
  });

  it('follows CLAUDE_CONFIG_DIR when the CLI has been moved', () => {
    expect(appPaths({ CLAUDE_CONFIG_DIR: '/elsewhere' }, '/home/dev', 'linux').claudeHome).toBe(
      '/elsewhere',
    );
  });
});

describe('projectSlug', () => {
  it('matches the slugs observed in real transcript paths', () => {
    expect(projectSlug('/home/dev/project')).toBe('-home-dev-project');
    expect(projectSlug('/home/dev/project/.claude/worktrees/agent-1')).toBe(
      '-home-dev-project--claude-worktrees-agent-1',
    );
  });
});

describe('expandPath', () => {
  it('leaves an empty value empty, so "unset" stays distinguishable', () => {
    expect(expandPath('')).toBe('');
  });

  it('resolves a bare ~ to the home directory', () => {
    expect(expandPath('~', '/home/dev')).toBe('/home/dev');
  });
});

describe('defaultConfig', () => {
  it('points the log at the state directory', () => {
    const dir = tempDir();
    try {
      mkdirSync(dir, { recursive: true });
      const config = defaultConfig(['/home/dev/project'], { HOME: '/home/dev' }, '/home/dev');
      expect(config.logging.file).toContain('rotorcc');
    } finally {
      cleanup(dir);
    }
  });
});
