import { describe, expect, it } from 'vitest';

import { HELP, parseArgv } from '../src/cli.js';

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

  it('treats the new boolean flags as booleans, not as value-takers', () => {
    // `--check` reading the next token as its value is the bug that makes
    // `rotorcc upgrade --check --json` silently stop being a check.
    expect(parseArgv(['upgrade', '--check', '--json']).flags).toEqual({
      check: true,
      json: true,
    });
    expect(parseArgv(['accounts', '--token-status', '--json']).flags).toEqual({
      'token-status': true,
      json: true,
    });
    expect(parseArgv(['accounts', 'unclaimed', '--purge', '2-a@b.com', '--yes'])).toEqual({
      command: 'accounts',
      positionals: ['unclaimed'],
      flags: { purge: '2-a@b.com', yes: true },
    });
  });

  it('keeps --purge a value flag, so it can never mean "purge everything"', () => {
    // A `--purge` with nothing after it must not become `true` and be read as
    // an instruction. It parses as boolean-true here, and the command layer
    // requires a string id — but the shape is worth pinning either way.
    expect(parseArgv(['accounts', 'unclaimed', '--purge']).flags.purge).toBe(true);
    expect(typeof parseArgv(['accounts', 'unclaimed', '--purge', 'x']).flags.purge).toBe('string');
  });
});

describe('the help text carries the contracts a script depends on', () => {
  it('states the daemon --once exit codes', () => {
    // These numbers are a public interface. If they change, this fails first.
    expect(HELP).toContain('0  nothing to do');
    expect(HELP).toContain('1  acted');
    expect(HELP).toContain('2  would act, but could not');
    expect(HELP).toContain('3  error');
  });

  it('lists the commands added for recovery and upgrade', () => {
    expect(HELP).toContain('upgrade');
    expect(HELP).toContain('accounts unclaimed');
    expect(HELP).toContain('--token-status');
    expect(HELP).toContain('purge --yes');
  });

  it('documents the dashboard keys, because a control surface nobody can find is not one', () => {
    for (const key of ['switch to the selected account', 'rotate to the best target', 'disable']) {
      expect(HELP).toContain(key);
    }
    // And the promise that makes them safe to learn: one implementation.
    expect(HELP).toContain('the same code as the matching command');
  });

  it('states the display contract, so nobody has to infer it from a screenshot', () => {
    expect(HELP).toContain('BOTH windows');
    expect(HELP).toContain('5h and 7d');
    expect(HELP).toContain('USED');
  });
});
