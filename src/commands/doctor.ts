/**
 * `rotorcc doctor` — check every assumption rotorcc makes, and say plainly
 * which ones are false.
 *
 * Each check reports pass, warn or fail, and a fix. "warn" means rotorcc works
 * with a piece missing (no mirror, no tmux); "fail" means it does not.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Config } from '../config/schema.js';
import { configPathFor } from '../config/load.js';
import { appPaths, currentPlatform, isWsl } from '../core/paths.js';
import { commandExists, run } from '../core/proc.js';
import { invalidPatterns } from '../core/secrets.js';
import { type Store } from '../core/state.js';
import { projectTranscriptDir } from '../core/transcripts.js';
import { readingFromAutoStream, readingFromListOutput } from '../core/usage.js';
import { countRotorccHooks, installedEvents } from '../core/settingsMerge.js';
import { readSettings, settingsPathFor } from './installHooks.js';

export type CheckStatus = 'pass' | 'warn' | 'fail';

export interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
  fix?: string;
}

export async function runDoctor(
  config: Config,
  store: Store,
  configPath?: string,
): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (check: Check) => checks.push(check);
  const paths = appPaths();

  add({
    name: 'platform',
    status: 'pass',
    detail: `${currentPlatform()}${isWsl() ? ' (WSL)' : ''}, node ${process.version}`,
  });

  add({
    name: 'config',
    status: 'pass',
    detail: configPathFor(configPath),
  });

  add(
    existsSync(config.claudeHome)
      ? { name: 'claude home', status: 'pass', detail: config.claudeHome }
      : {
          name: 'claude home',
          status: 'fail',
          detail: `${config.claudeHome} does not exist`,
          fix: 'Set `claudeHome` in the config, or set CLAUDE_CONFIG_DIR to wherever the CLI keeps its state.',
        },
  );

  for (const program of ['git', 'cswap'] as const) {
    const argv = config.commands[program];
    const ok = await commandExists(argv);
    add(
      ok
        ? { name: program, status: 'pass', detail: argv.join(' ') }
        : {
            name: program,
            status: 'fail',
            detail: `${argv.join(' ')} is not runnable`,
            fix:
              program === 'cswap'
                ? 'Install the account switcher, or point `commands.cswap` at yours. Without it rotorcc can still checkpoint, but it cannot rotate.'
                : 'Install git, or point `commands.git` at it.',
          },
    );
  }

  if (config.successor.launcher === 'tmux') {
    const ok = await commandExists(config.commands.tmux);
    add(
      ok
        ? { name: 'tmux', status: 'pass', detail: config.commands.tmux.join(' ') }
        : {
            name: 'tmux',
            status: 'fail',
            detail: 'successor.launcher is "tmux" but tmux is not runnable',
            fix: 'Install tmux, or set `successor.launcher` to "none" and start the replacement session yourself.',
          },
    );
  }

  if (config.mirror.type === 'rsync-ssh') {
    const ok = await commandExists(config.commands.rsync);
    add(
      ok
        ? { name: 'rsync', status: 'pass', detail: config.mirror.target }
        : {
            name: 'rsync',
            status: 'fail',
            detail: 'mirror.type is "rsync-ssh" but rsync is not runnable',
            fix: 'Install rsync, switch `mirror.type` to "git-remote", or set it to "none".',
          },
    );
  }

  // Usage source: read it for real, and cross-check the two shapes it can emit.
  const list = await run([...config.commands.cswap, 'list', '--json'], { timeoutMs: 45_000 });
  if (!list.ok) {
    add({
      name: 'usage source',
      status: 'fail',
      detail: (list.error ?? list.stderr).slice(0, 200),
      fix: 'Run the switcher by hand and make sure it is logged in.',
    });
  } else {
    try {
      const reading = readingFromListOutput(JSON.parse(list.stdout), { models: config.models });
      const active = reading.accounts.find((a) => a.active);
      add({
        name: 'usage source',
        status: 'pass',
        detail: `${reading.accounts.length} account(s); active #${active?.number ?? '?'} at ${active?.headroomPct.toFixed(0) ?? '?'}% headroom on ${active?.bindingWindow ?? '?'}`,
      });

      const auto = await run(
        [
          ...config.commands.cswap,
          'auto',
          '--once',
          '--json',
          '--dry-run',
          '--threshold',
          String(Math.max(50, Math.min(99.9, 100 - config.thresholds.rotatePct))),
        ],
        { timeoutMs: 60_000, okCodes: [2, 3] },
      );
      const crossCheck = readingFromAutoStream(auto.stdout);
      if (crossCheck === null) {
        add({
          name: 'usage cross-check',
          status: 'warn',
          detail: 'the switcher did not emit a poll event to compare against',
        });
      } else {
        const a = active?.headroomPct ?? -1;
        const b = crossCheck.accounts.find((x) => x.active)?.headroomPct ?? -1;
        const agree = Math.abs(a - b) <= 2;
        add({
          name: 'usage cross-check',
          status: agree ? 'pass' : 'warn',
          detail: agree
            ? `both readings agree (${a.toFixed(0)}% headroom)`
            : `list says ${a.toFixed(0)}% and auto says ${b.toFixed(0)}%; rotorcc uses list`,
        });
      }
    } catch (err) {
      add({
        name: 'usage source',
        status: 'fail',
        detail: `output was not the expected shape: ${String(err).slice(0, 160)}`,
        fix: 'Check the switcher version; rotorcc expects `list --json` with per-account usage windows.',
      });
    }
  }

  for (const project of config.projects) {
    const gitOk = existsSync(join(project.path, '.git'));
    add(
      gitOk
        ? { name: `project ${project.path}`, status: 'pass', detail: 'git repository found' }
        : {
            name: `project ${project.path}`,
            status: 'fail',
            detail: 'not a git repository',
            fix: 'Point `projects[].path` at a repository root.',
          },
    );

    const transcripts = projectTranscriptDir(config, project.path);
    add(
      existsSync(transcripts)
        ? { name: `transcripts ${project.path}`, status: 'pass', detail: transcripts }
        : {
            name: `transcripts ${project.path}`,
            status: 'warn',
            detail: `${transcripts} does not exist yet`,
            fix: 'It appears the first time a session runs in this directory. Nothing to do.',
          },
    );

    try {
      const settingsPath = settingsPathFor({ projectPath: project.path });
      const settings = readSettings(settingsPath);
      const count = countRotorccHooks(settings);
      add(
        count > 0
          ? {
              name: `hooks ${project.path}`,
              status: 'pass',
              detail: `${count} entr(ies): ${installedEvents(settings).join(', ')}`,
            }
          : {
              name: `hooks ${project.path}`,
              status: 'warn',
              detail:
                'no rotorcc hooks installed; only the every-minute watcher protects this project',
              fix: `rotorcc install-hooks ${project.path}`,
            },
      );
    } catch (err) {
      add({
        name: `hooks ${project.path}`,
        status: 'fail',
        detail: String(err).slice(0, 200),
      });
    }
  }

  const storeGit = existsSync(join(config.storePath, '.git'));
  add(
    storeGit
      ? { name: 'transcript store', status: 'pass', detail: config.storePath }
      : {
          name: 'transcript store',
          status: 'warn',
          detail: `${config.storePath} is not initialised yet`,
          fix: 'rotorcc snapshot',
        },
  );

  const bad = invalidPatterns(config.secretsScreen.extraPatterns);
  add(
    bad.length === 0
      ? {
          name: 'secrets screen',
          status: config.secretsScreen.enabled ? 'pass' : 'warn',
          detail: config.secretsScreen.enabled
            ? `enabled, ${config.secretsScreen.extraPatterns.length} extra pattern(s)`
            : 'disabled: snapshots will be mirrored without screening',
        }
      : {
          name: 'secrets screen',
          status: 'fail',
          detail: `${bad.length} extra pattern(s) are not valid regular expressions: ${bad.join(', ')}`,
          fix: 'Fix or remove them; an invalid pattern is skipped, so the screen is weaker than it looks.',
        },
  );

  const state = store.readState();
  add({
    name: 'state',
    status: 'pass',
    detail: `last snapshot ${state.lastSnapshotAt ?? 'never'}; latches ${Object.keys(state.latches).join(',') || 'none'}`,
  });

  add({
    name: 'log',
    status: 'pass',
    detail: config.logging.file === '' ? paths.logFile : config.logging.file,
  });

  return checks;
}

export function renderDoctor(checks: Check[]): string {
  const symbol: Record<CheckStatus, string> = { pass: 'ok  ', warn: 'warn', fail: 'FAIL' };
  const lines = ['rotorcc doctor', ''];
  for (const check of checks) {
    lines.push(`  ${symbol[check.status]}  ${check.name.padEnd(34)} ${check.detail}`);
    if (check.fix !== undefined && check.status !== 'pass') {
      lines.push(`        ${' '.repeat(34)} -> ${check.fix}`);
    }
  }
  const failed = checks.filter((c) => c.status === 'fail').length;
  const warned = checks.filter((c) => c.status === 'warn').length;
  lines.push('');
  lines.push(
    failed > 0
      ? `${failed} check(s) failed, ${warned} warning(s). rotorcc will not work correctly until those are fixed.`
      : warned > 0
        ? `All required checks passed, with ${warned} warning(s).`
        : 'All checks passed.',
  );
  lines.push('');
  return lines.join('\n');
}

export function readManifestSafely(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}
