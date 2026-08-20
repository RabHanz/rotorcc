/**
 * Getting `rotorcc daemon --once` to run every minute, on each platform's own
 * terms.
 *
 * A periodic one-shot beats a long-lived process here. The tick is cheap and
 * stateless; a resident daemon on a laptop is a thing that gets OOM-killed at
 * 3am and is never noticed. systemd, launchd and Task Scheduler all restart a
 * one-shot for free, and none of them will restart a process they did not
 * notice dying.
 *
 * `rotorcc daemon` (no --once) is still there for anything none of these fit.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { currentPlatform } from './paths.js';
import { run } from './proc.js';

export interface SchedulerPlan {
  kind: 'systemd' | 'launchd' | 'schtasks' | 'foreground';
  /** Files the installer will write. */
  files: Array<{ path: string; contents: string }>;
  /** Commands the installer will run, in order. */
  commands: string[][];
  /** Commands that undo the install. */
  uninstallCommands: string[][];
  /** Files the uninstaller should delete. */
  uninstallFiles: string[];
  notes: string[];
}

export interface SchedulerInput {
  /**
   * Absolute path to the node binary running the installer.
   *
   * Not "node". A systemd user unit and a launchd agent both start with a
   * minimal environment, and a version manager (nvm, fnm, volta) puts node
   * somewhere that minimal PATH has never heard of. The unit that shipped
   * before this was pinned failed on first tick with
   * `/usr/bin/env: 'node': No such file or directory`.
   */
  node: string;
  /** Absolute path to the CLI entry script. */
  script: string;
  /** Extra args, e.g. ['--config', '/path/config.json']. */
  args: string[];
  pollSeconds: number;
  /**
   * The PATH to give the scheduled process. Same reasoning: rotorcc shells out
   * to git and to the account switcher, and a switcher installed in
   * ~/.local/bin is invisible to a default user-unit PATH.
   */
  path?: string;
  home?: string;
  platform?: ReturnType<typeof currentPlatform>;
}

/** systemd's ExecStart accepts double-quoted words; a path may contain spaces. */
function systemdQuote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function systemdPlan(input: SchedulerInput, home: string): SchedulerPlan {
  const unitDir = join(home, '.config', 'systemd', 'user');
  const exec = [input.node, input.script, 'daemon', '--once', ...input.args]
    .map(systemdQuote)
    .join(' ');
  const service = [
    '[Unit]',
    'Description=rotorcc watch tick',
    '',
    '[Service]',
    'Type=oneshot',
    ...(input.path !== undefined && input.path !== '' ? [`Environment=PATH=${input.path}`] : []),
    `ExecStart=${exec}`,
    // `daemon --once` exits 1 when it ACTED and 2 when it wanted to and could
    // not. Both are the watcher doing its job, and without this systemd marks
    // the unit `failed` on exactly those ticks — a red unit every time rotorcc
    // checkpoints, and any alert on unit failure firing continuously.
    //
    // The cost, stated rather than hidden: node also exits 1 on an uncaught
    // exception during module load, and that is indistinguishable here, so a
    // watcher broken badly enough to die before it runs reports success. Two
    // things cover it. `daemon --once` catches its own throws and exits 3, so
    // everything after startup is honest; and `rotorcc doctor` checks when the
    // last tick actually happened, so a silently dead watcher is visible from
    // the one command an operator runs when something feels wrong.
    'SuccessExitStatus=1 2',
    // A tick that hangs must not stack up behind the next one.
    'TimeoutStartSec=300',
    // This runs on a machine somebody is working on. It gets the leftovers.
    'Nice=10',
    'IOSchedulingClass=idle',
    'CPUSchedulingPolicy=idle',
    'MemoryMax=512M',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');

  const timer = [
    '[Unit]',
    'Description=rotorcc watch tick timer',
    '',
    '[Timer]',
    'OnBootSec=2min',
    `OnUnitInactiveSec=${input.pollSeconds}s`,
    'AccuracySec=10s',
    'Persistent=false',
    'Unit=rotorcc.service',
    '',
    '[Install]',
    'WantedBy=timers.target',
    '',
  ].join('\n');

  return {
    kind: 'systemd',
    files: [
      { path: join(unitDir, 'rotorcc.service'), contents: service },
      { path: join(unitDir, 'rotorcc.timer'), contents: timer },
    ],
    commands: [
      ['systemctl', '--user', 'daemon-reload'],
      ['systemctl', '--user', 'enable', '--now', 'rotorcc.timer'],
    ],
    uninstallCommands: [
      ['systemctl', '--user', 'disable', '--now', 'rotorcc.timer'],
      ['systemctl', '--user', 'daemon-reload'],
    ],
    uninstallFiles: [join(unitDir, 'rotorcc.service'), join(unitDir, 'rotorcc.timer')],
    notes: [
      'Check it with: systemctl --user list-timers rotorcc.timer',
      'Read its log with: journalctl --user -u rotorcc.service -n 50',
      'If your session does not linger, the timer stops when you log out: loginctl enable-linger $USER',
    ],
  };
}

function launchdPlan(input: SchedulerInput, home: string): SchedulerPlan {
  const label = 'dev.rotorcc.watch';
  const plistPath = join(home, 'Library', 'LaunchAgents', `${label}.plist`);
  const argv = [input.node, input.script, 'daemon', '--once', ...input.args];
  const args = argv.map((a) => `    <string>${escapeXml(a)}</string>`).join('\n');
  const plist = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${label}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    args,
    '  </array>',
    // launchd starts with its own minimal PATH, exactly like systemd does.
    ...(input.path !== undefined && input.path !== ''
      ? [
          '  <key>EnvironmentVariables</key>',
          '  <dict>',
          '    <key>PATH</key>',
          `    <string>${escapeXml(input.path)}</string>`,
          '  </dict>',
        ]
      : []),
    '  <key>StartInterval</key>',
    `  <integer>${input.pollSeconds}</integer>`,
    '  <key>RunAtLoad</key>',
    '  <false/>',
    '  <key>LowPriorityIO</key>',
    '  <true/>',
    '  <key>Nice</key>',
    '  <integer>10</integer>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n');

  return {
    kind: 'launchd',
    files: [{ path: plistPath, contents: plist }],
    commands: [
      ['launchctl', 'unload', plistPath],
      ['launchctl', 'load', plistPath],
    ],
    uninstallCommands: [['launchctl', 'unload', plistPath]],
    uninstallFiles: [plistPath],
    notes: [
      `Check it with: launchctl list | grep ${label}`,
      'launchd rounds StartInterval when the machine sleeps; a missed tick is caught up on wake.',
      // launchd has no SuccessExitStatus, so a tick that ACTED (exit 1) or was
      // blocked (2) is recorded as a non-zero exit in `launchctl list`. It has
      // no consequence — KeepAlive is not set, so nothing restarts or backs off
      // — but an operator reading that column should know it is the contract
      // and not a fault.
      'A non-zero "last exit" in launchctl list is normal: `daemon --once` exits 1 when it ' +
        'acted and 2 when it could not. Only 3 is an error.',
    ],
  };
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function schtasksPlan(input: SchedulerInput): SchedulerPlan {
  const name = 'rotorcc-watch';
  // schtasks takes whole minutes, and its floor is 1.
  const minutes = Math.max(1, Math.round(input.pollSeconds / 60));
  // Task Scheduler takes one command string, so each argument is quoted here.
  const command = [input.node, input.script, 'daemon', '--once', ...input.args]
    .map((part) => (/\s/.test(part) ? `"${part}"` : part))
    .join(' ');
  return {
    kind: 'schtasks',
    files: [],
    commands: [
      [
        'schtasks',
        '/Create',
        '/F',
        '/SC',
        'MINUTE',
        '/MO',
        String(minutes),
        '/TN',
        name,
        '/TR',
        command,
      ],
    ],
    uninstallCommands: [['schtasks', '/Delete', '/F', '/TN', name]],
    uninstallFiles: [],
    notes: [
      `Check it with: schtasks /Query /TN ${name}`,
      minutes * 60 !== input.pollSeconds
        ? `Task Scheduler works in whole minutes, so the interval was rounded to ${minutes} minute(s).`
        : 'Interval matches pollSeconds exactly.',
      'The task runs only while you are logged in. For anything longer-running, use `rotorcc daemon` in a terminal or under WSL with systemd.',
    ],
  };
}

export function schedulerPlan(input: SchedulerInput): SchedulerPlan {
  const home = input.home ?? homedir();
  const platform = input.platform ?? currentPlatform();
  if (platform === 'linux') return systemdPlan(input, home);
  if (platform === 'darwin') return launchdPlan(input, home);
  if (platform === 'win32') return schtasksPlan(input);
  return {
    kind: 'foreground',
    files: [],
    commands: [],
    uninstallCommands: [],
    uninstallFiles: [],
    notes: [
      'No scheduler adapter for this platform.',
      `Run it in a terminal instead: ${[input.node, input.script, 'daemon', ...input.args].join(' ')}`,
    ],
  };
}

export async function applyPlan(
  plan: SchedulerPlan,
  dryRun: boolean,
): Promise<{ ok: boolean; log: string[] }> {
  const log: string[] = [];
  for (const file of plan.files) {
    log.push(`${dryRun ? 'would write' : 'wrote'} ${file.path}`);
    if (!dryRun) {
      mkdirSync(dirname(file.path), { recursive: true });
      writeFileSync(file.path, file.contents, 'utf8');
    }
  }
  let ok = true;
  for (const command of plan.commands) {
    if (dryRun) {
      log.push(`would run ${command.join(' ')}`);
      continue;
    }
    const result = await run(command, { timeoutMs: 60_000, okCodes: [1, 3, 113] });
    log.push(
      `${command.join(' ')} -> ${result.ok ? 'ok' : (result.error ?? result.stderr).trim()}`,
    );
    // The first `launchctl unload` of a plist that was never loaded fails, and
    // that is fine; a failure of the last command is not.
    ok = result.ok;
  }
  return { ok, log };
}
