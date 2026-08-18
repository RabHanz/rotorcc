import { describe, expect, it } from 'vitest';

import { parseArgv } from '../src/cli.js';

describe('parseArgv', () => {
  it('reads a bare command', () => {
    expect(parseArgv(['status'])).toEqual({ command: 'status', positionals: [], flags: {} });
  });

  it('reads positionals and boolean flags', () => {
    expect(parseArgv(['install-hooks', '/home/dev/project', '--dry-run'])).toEqual({
      command: 'install-hooks',
      positionals: ['/home/dev/project'],
      flags: { 'dry-run': true },
    });
  });

  it('reads a flag with a separate value and with an equals sign', () => {
    expect(parseArgv(['daemon', '--config', '/a/b.json']).flags).toEqual({ config: '/a/b.json' });
    expect(parseArgv(['daemon', '--config=/a/b.json']).flags).toEqual({ config: '/a/b.json' });
  });

  it('treats a flag followed by another flag as boolean', () => {
    expect(parseArgv(['daemon', '--once', '--json']).flags).toEqual({ once: true, json: true });
  });

  it('keeps a value that happens to start with a digit or a slash', () => {
    expect(parseArgv(['config', 'set', 'pollSeconds', '90']).positionals).toEqual([
      'set',
      'pollSeconds',
      '90',
    ]);
  });

  it('defaults to help with no arguments at all', () => {
    expect(parseArgv([]).command).toBe('help');
  });

  it('does not let a boolean flag swallow the positional after it', () => {
    expect(parseArgv(['init', '--yes', '/home/dev/project'])).toEqual({
      command: 'init',
      positionals: ['/home/dev/project'],
      flags: { yes: true },
    });
    expect(parseArgv(['install-hooks', '--user', '/home/dev/project']).positionals).toEqual([
      '/home/dev/project',
    ]);
    expect(parseArgv(['daemon', '--once', '--config', '/a.json']).flags).toEqual({
      once: true,
      config: '/a.json',
    });
  });

  it('does not mistake a leading flag for a command', () => {
    expect(parseArgv(['--help'])).toEqual({
      command: 'help',
      positionals: [],
      flags: { help: true },
    });
    expect(parseArgv(['--version']).flags).toEqual({ version: true });
    expect(parseArgv(['-v']).flags).toEqual({ v: true });
    expect(parseArgv(['-h']).flags).toEqual({ h: true });
  });
});
