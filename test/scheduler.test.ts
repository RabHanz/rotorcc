/**
 * The scheduler plan is generated, not templated by hand, so these tests check
 * that each platform gets a unit it will actually accept — and that a platform
 * with no adapter says so plainly instead of silently doing nothing.
 */
import { describe, expect, it } from 'vitest';

import { schedulerPlan } from '../src/core/scheduler.js';

const input = {
  node: '/home/dev/.nvm/versions/node/v22.0.0/bin/node',
  script: '/home/dev/.npm-global/lib/node_modules/rotorcc/dist/cli.js',
  args: ['--config', '/home/dev/.config/rotorcc/config.json'],
  pollSeconds: 60,
  path: '/home/dev/.nvm/versions/node/v22.0.0/bin:/home/dev/.local/bin:/usr/bin:/bin',
  home: '/home/dev',
};

describe('schedulerPlan — linux', () => {
  const plan = schedulerPlan({ ...input, platform: 'linux' });

  it('writes a user service and a timer under the user unit directory', () => {
    expect(plan.kind).toBe('systemd');
    expect(plan.files.map((f) => f.path)).toEqual([
      '/home/dev/.config/systemd/user/rotorcc.service',
      '/home/dev/.config/systemd/user/rotorcc.timer',
    ]);
  });

  it('runs a one-shot tick, not a resident process', () => {
    const service = plan.files[0]?.contents ?? '';
    expect(service).toContain('Type=oneshot');
    expect(service).toContain('daemon" "--once"');
  });

  it('pins the absolute node binary, because a user unit has no version manager', () => {
    const service = plan.files[0]?.contents ?? '';
    expect(service).toContain(`ExecStart="${input.node}" "${input.script}"`);
    expect(service).not.toMatch(/ExecStart=node /);
    expect(service).not.toContain('/usr/bin/env');
  });

  it('gives the unit a PATH, because it shells out to git and the switcher', () => {
    expect(plan.files[0]?.contents).toContain(`Environment=PATH=${input.path}`);
  });

  it('quotes the ExecStart words, so a path with a space survives', () => {
    const spaced = schedulerPlan({
      ...input,
      platform: 'linux',
      script: '/home/dev/My Tools/rotorcc/dist/cli.js',
    });
    expect(spaced.files[0]?.contents).toContain('"/home/dev/My Tools/rotorcc/dist/cli.js"');
  });

  it('takes the leftovers of a machine somebody is working on', () => {
    const service = plan.files[0]?.contents ?? '';
    expect(service).toContain('Nice=10');
    expect(service).toContain('IOSchedulingClass=idle');
    expect(service).toContain('MemoryMax=512M');
  });

  it('spaces ticks by the configured interval, measured from the last finish', () => {
    const timer = plan.files[1]?.contents ?? '';
    expect(timer).toContain('OnUnitInactiveSec=60s');
    expect(timer).toContain('Unit=rotorcc.service');
  });

  it('installs and uninstalls symmetrically', () => {
    expect(plan.commands).toContainEqual([
      'systemctl',
      '--user',
      'enable',
      '--now',
      'rotorcc.timer',
    ]);
    expect(plan.uninstallCommands).toContainEqual([
      'systemctl',
      '--user',
      'disable',
      '--now',
      'rotorcc.timer',
    ]);
    expect(plan.uninstallFiles).toEqual(plan.files.map((f) => f.path));
  });

  it('mentions lingering, which is why these timers usually stop', () => {
    expect(plan.notes.join(' ')).toContain('linger');
  });
});

describe('schedulerPlan — macOS', () => {
  const plan = schedulerPlan({ ...input, platform: 'darwin' });

  it('writes a LaunchAgent plist', () => {
    expect(plan.kind).toBe('launchd');
    expect(plan.files[0]?.path).toBe('/home/dev/Library/LaunchAgents/dev.rotorcc.watch.plist');
  });

  it('puts each argument in its own string element, so paths with spaces survive', () => {
    const plist = plan.files[0]?.contents ?? '';
    expect(plist).toContain(`<string>${input.node}</string>`);
    expect(plist).toContain(`<string>${input.script}</string>`);
    expect(plist).toContain('<string>daemon</string>');
    expect(plist).toContain('<string>--once</string>');
    expect(plist).toContain('<integer>60</integer>');
  });

  it('sets PATH, because a LaunchAgent starts as bare as a systemd user unit', () => {
    const plist = plan.files[0]?.contents ?? '';
    expect(plist).toContain('<key>EnvironmentVariables</key>');
    expect(plist).toContain(`<string>${input.path}</string>`);
  });

  it('escapes XML rather than producing an invalid plist', () => {
    const withAmpersand = schedulerPlan({
      ...input,
      platform: 'darwin',
      args: ['--config', '/tmp/a&b.json'],
    });
    expect(withAmpersand.files[0]?.contents).toContain('/tmp/a&amp;b.json');
  });
});

describe('schedulerPlan — Windows', () => {
  it('creates a minute-interval scheduled task', () => {
    const plan = schedulerPlan({ ...input, platform: 'win32' });
    expect(plan.kind).toBe('schtasks');
    expect(plan.commands[0]).toContain('/SC');
    expect(plan.commands[0]).toContain('MINUTE');
    expect(plan.commands[0]).toContain('rotorcc-watch');
    expect(plan.commands[0]?.[plan.commands[0].indexOf('/TR') + 1]).toContain(input.node);
  });

  it('quotes a command path containing a space', () => {
    const plan = schedulerPlan({
      ...input,
      platform: 'win32',
      script: 'C:\\Program Files\\rotorcc\\cli.js',
    });
    expect(plan.commands[0]?.join(' ')).toContain('"C:\\Program Files\\rotorcc\\cli.js"');
  });

  it('says out loud when it had to round the interval', () => {
    const plan = schedulerPlan({ ...input, platform: 'win32', pollSeconds: 90 });
    expect(plan.notes.join(' ')).toContain('rounded');
    // Never rounds down to zero, which schtasks rejects.
    expect(plan.commands[0]?.[plan.commands[0].indexOf('/MO') + 1]).toBe('2');
  });

  it('rounds a sub-minute interval up to one minute, not down to none', () => {
    const plan = schedulerPlan({ ...input, platform: 'win32', pollSeconds: 20 });
    expect(plan.commands[0]?.[plan.commands[0].indexOf('/MO') + 1]).toBe('1');
  });
});

describe('schedulerPlan — anything else', () => {
  it('admits it has no adapter and gives the command to run by hand', () => {
    const plan = schedulerPlan({ ...input, platform: 'other' });
    expect(plan.kind).toBe('foreground');
    expect(plan.files).toEqual([]);
    expect(plan.commands).toEqual([]);
    expect(plan.notes.join(' ')).toContain(`${input.node} ${input.script} daemon`);
  });
});
