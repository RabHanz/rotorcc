/**
 * The settings file belongs to the user, not to rotorcc. These tests exist to
 * make "it will not clobber your hooks" a fact rather than an intention.
 */
import { describe, expect, it } from 'vitest';

import {
  type SettingsFile,
  DEFAULT_HOOK_SPECS,
  SENTINEL,
  countRotorccHooks,
  installRotorccHooks,
  installedEvents,
  isRotorccHook,
  removeRotorccHooks,
} from '../src/core/settingsMerge.js';

const BIN = '/usr/local/bin/rotorcc';

const existing: SettingsFile = {
  permissions: { allow: ['Bash(git status)'], deny: ['Read(./.env)'] },
  model: 'some-model',
  hooks: {
    PreToolUse: [
      {
        matcher: 'Bash',
        hooks: [
          { type: 'command', command: 'pnpm', args: ['exec', 'tsx', 'guard.ts'], timeout: 20 },
        ],
      },
    ],
    Stop: [
      {
        hooks: [{ type: 'command', command: 'notify-send', args: ['done'] }],
      },
    ],
  },
};

describe('installRotorccHooks', () => {
  it('adds an entry for every event it needs', () => {
    const { settings, added } = installRotorccHooks({}, BIN);
    expect(added).toBe(DEFAULT_HOOK_SPECS.length);
    expect(installedEvents(settings)).toEqual([...DEFAULT_HOOK_SPECS.map((s) => s.event)].sort());
  });

  it('leaves every other setting exactly as it found it', () => {
    const { settings } = installRotorccHooks(structuredClone(existing), BIN);
    expect(settings.permissions).toEqual(existing.permissions);
    expect(settings.model).toBe('some-model');
  });

  it('keeps the user’s own hooks on an event it also uses', () => {
    const { settings } = installRotorccHooks(structuredClone(existing), BIN);
    const stop = settings.hooks?.Stop ?? [];
    const foreign = stop.flatMap((e) => e.hooks).filter((h) => !isRotorccHook(h));
    expect(foreign).toHaveLength(1);
    expect(foreign[0]?.command).toBe('notify-send');
  });

  it('keeps hooks on events it does not touch at all', () => {
    const { settings } = installRotorccHooks(structuredClone(existing), BIN);
    expect(settings.hooks?.PreToolUse).toEqual(existing.hooks?.PreToolUse);
  });

  it('is idempotent: installing twice gives a byte-identical file', () => {
    const once = installRotorccHooks(structuredClone(existing), BIN).settings;
    const twice = installRotorccHooks(structuredClone(once), BIN).settings;
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
    expect(countRotorccHooks(twice)).toBe(DEFAULT_HOOK_SPECS.length);
  });

  it('reinstalls cleanly after the binary path changes, without stacking duplicates', () => {
    const first = installRotorccHooks(structuredClone(existing), '/old/rotorcc').settings;
    const second = installRotorccHooks(structuredClone(first), '/new/rotorcc');
    expect(second.removed).toBe(DEFAULT_HOOK_SPECS.length);
    expect(countRotorccHooks(second.settings)).toBe(DEFAULT_HOOK_SPECS.length);
    const commands = Object.values(second.settings.hooks ?? {})
      .flat()
      .flatMap((e) => e.hooks)
      .map((h) => h.command);
    expect(commands).not.toContain('/old/rotorcc');
    expect(new Set(commands)).toEqual(new Set(['/new/rotorcc', 'pnpm', 'notify-send']));
  });

  it('marks its own entries with a sentinel so removal is exact', () => {
    const { settings } = installRotorccHooks({}, BIN);
    const hook = settings.hooks?.Stop?.[0]?.hooks[0];
    expect(hook?.args).toContain(SENTINEL);
    expect(hook?.args?.slice(0, 2)).toEqual(['hook', 'Stop']);
  });

  it('passes a config path through to the hook when one is given', () => {
    const { settings } = installRotorccHooks({}, BIN, DEFAULT_HOOK_SPECS, [
      '--config',
      '/etc/rotorcc.json',
    ]);
    expect(settings.hooks?.SessionStart?.[0]?.hooks[0]?.args).toEqual([
      'hook',
      'SessionStart',
      SENTINEL,
      '--config',
      '/etc/rotorcc.json',
    ]);
  });
});

describe('removeRotorccHooks', () => {
  it('takes out exactly what it put in', () => {
    const installed = installRotorccHooks(structuredClone(existing), BIN).settings;
    const { settings, removed } = removeRotorccHooks(installed);
    expect(removed).toBe(DEFAULT_HOOK_SPECS.length);
    expect(JSON.stringify(settings)).toBe(JSON.stringify(existing));
  });

  it('does nothing to a settings file it was never installed into', () => {
    const { settings, removed } = removeRotorccHooks(structuredClone(existing));
    expect(removed).toBe(0);
    expect(settings).toEqual(existing);
  });

  it('does not remove a lookalike hook that lacks the sentinel', () => {
    const impostor: SettingsFile = {
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: BIN, args: ['hook', 'Stop'] }] }],
      },
    };
    const { removed } = removeRotorccHooks(impostor);
    expect(removed).toBe(0);
  });

  it('drops the hooks key entirely when nothing else was there', () => {
    const installed = installRotorccHooks({}, BIN).settings;
    const { settings } = removeRotorccHooks(installed);
    expect(settings.hooks).toBeUndefined();
  });
});
