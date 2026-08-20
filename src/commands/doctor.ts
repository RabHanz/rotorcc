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
import { AccountManager, formatAge } from '../accounts/manager.js';
import { DecisionJournal } from '../core/history.js';
import { headroomIsKnown } from '../core/usage.js';
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

  {
    const argv = config.commands.git;
    const ok = await commandExists(argv);
    add(
      ok
        ? { name: 'git', status: 'pass', detail: argv.join(' ') }
        : {
            name: 'git',
            status: 'fail',
            detail: `${argv.join(' ')} is not runnable`,
            fix: 'Install git, or point `commands.git` at it.',
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

  await checkAccounts(config, add);

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

  addWatcherFreshness(config, store, add);

  add({
    name: 'log',
    status: 'pass',
    detail: config.logging.file === '' ? paths.logFile : config.logging.file,
  });

  return checks;
}

/**
 * When did the watcher last actually tick?
 *
 * The scheduler unit rotorcc installs treats exit 1 and 2 as success, because
 * both mean the tick did its job — which makes node's own exit-1 crash look
 * identical to a healthy run. A watcher that dies before `main` therefore shows
 * a green unit forever, and the operator finds out weeks later that nothing was
 * ever watched.
 *
 * This is the check that makes that visible. The decision journal records EVERY
 * tick, idle ones included, precisely so "has it been running" is a question
 * with an answer.
 */
function addWatcherFreshness(config: Config, store: Store, add: (check: Check) => void): void {
  const newest = new DecisionJournal(store.dir).recent(1)[0];
  if (newest === undefined) {
    add({
      name: 'watcher',
      status: 'warn',
      detail: 'no tick has ever been recorded',
      fix: 'rotorcc install-scheduler, or run "rotorcc daemon --once" to check it works at all.',
    });
    return;
  }
  const ageMs = Date.now() - Date.parse(newest.at);
  if (!Number.isFinite(ageMs)) {
    add({ name: 'watcher', status: 'warn', detail: `last tick recorded at "${newest.at}"` });
    return;
  }
  // Three intervals: one missed tick is a busy machine, three is a pattern.
  const staleAfterMs = Math.max(3 * config.pollSeconds, 180) * 1000;
  const age = formatAge(Math.max(0, ageMs));
  add(
    ageMs <= staleAfterMs
      ? { name: 'watcher', status: 'pass', detail: `last tick ${age} ago` }
      : {
          name: 'watcher',
          status: 'warn',
          detail: `last tick ${age} ago — the watcher looks stopped`,
          fix:
            'The scheduler unit counts exit 1 and 2 as success, so a watcher that crashes at ' +
            'startup still shows green. Run "rotorcc daemon --once" by hand to see the real ' +
            'error, and check the scheduler with "rotorcc install-scheduler".',
        },
  );
}

/**
 * The account checks.
 *
 * `doctor` is where "rotorcc reports confidently while doing nothing" is
 * supposed to be caught before it costs anybody a session, so these checks are
 * written to be noisy about ambiguity rather than tidy:
 *
 *   - an account whose quota could not be read is a WARN with the reason, not
 *     a silent omission from a count;
 *   - a live login rotorcc does not manage is a WARN, because every threshold
 *     in this tool is about "the active account" and it would be measuring
 *     someone else's;
 *   - a roster with no accounts is a FAIL, because in that state rotorcc
 *     cannot rotate at all and the operator needs to know now, not at 4%.
 */
async function checkAccounts(config: Config, add: (check: Check) => void): Promise<void> {
  const manager = AccountManager.forConfig(config, {
    ...(config.accountsDir === '' ? {} : { accountsDir: config.accountsDir }),
  });

  add({
    name: 'account store',
    status: 'pass',
    detail: manager.accountsDir,
  });

  if (!manager.hasAccounts()) {
    // The external switcher is checked ONLY here — as the migration fallback it
    // now is, never as a dependency. A machine with rotorcc accounts of its own
    // does not care whether it is installed.
    const legacy = await commandExists(config.commands.cswap);
    add({
      name: 'accounts',
      status: 'fail',
      detail: legacy
        ? 'rotorcc manages no accounts of its own; it is falling back to an external switcher'
        : 'rotorcc manages no accounts, and there is no external switcher to fall back to',
      fix: legacy
        ? 'rotorcc accounts import --from-cswap   (one-off; rotorcc is standalone afterwards)'
        : 'rotorcc accounts add   (captures the login Claude Code is using right now)',
    });
    return;
  }

  const active = await manager.detectActiveSlot();
  add(
    active.slot !== null
      ? {
          name: 'active account',
          status: 'pass',
          detail: `slot ${active.slot} (${active.reason})`,
        }
      : {
          name: 'active account',
          status: 'warn',
          detail: active.reason,
          fix:
            'Every threshold rotorcc uses is about the ACTIVE account. Until this resolves, ' +
            'it is measuring accounts it manages while the machine runs on one it does not. ' +
            'Run "rotorcc accounts add" to bring the live login under management.',
        },
  );

  let reading;
  try {
    reading = await manager.readUsage();
  } catch (err) {
    add({
      name: 'quota read',
      status: 'fail',
      detail: String(err).slice(0, 200),
      fix: 'rotorcc cannot see any headroom, so it will never rotate. Fix this first.',
    });
    return;
  }

  const known = reading.accounts.filter((a) => headroomIsKnown(a));
  const unknown = reading.accounts.filter((a) => !headroomIsKnown(a));

  add(
    known.length > 0
      ? {
          name: 'quota read',
          status: unknown.length === 0 ? 'pass' : 'warn',
          detail:
            `${known.length} of ${reading.accounts.length} account(s) reported headroom` +
            (unknown.length === 0 ? '' : `; ${unknown.length} could not be measured`),
          ...(unknown.length === 0
            ? {}
            : {
                fix:
                  'Unmeasured accounts are never rotation targets, so rotorcc has fewer places ' +
                  'to go than it appears to. See the per-account lines below.',
              }),
        }
      : {
          name: 'quota read',
          status: 'fail',
          detail: 'not one account reported headroom',
          fix:
            'rotorcc cannot rotate onto an account it cannot measure, so in this state it will ' +
            'never rotate at all. This is the failure that costs a session — fix it now.',
        },
  );

  for (const account of unknown) {
    add({
      name: `account ${account.number}`,
      status: 'warn',
      detail: `headroom unknown — ${account.unknownReason ?? 'not measured'}`,
      fix: 'Not a rotation target while this holds.',
    });
  }

  const viable = known.filter(
    (a) =>
      !a.active &&
      a.disabled !== true &&
      a.kind !== 'api-key' &&
      a.headroomPct >= config.minTargetHeadroomPct,
  );
  add(
    viable.length > 0
      ? {
          name: 'rotation targets',
          status: 'pass',
          detail: `${viable.length} account(s) have at least ${config.minTargetHeadroomPct}% headroom`,
        }
      : {
          name: 'rotation targets',
          status: 'warn',
          detail: `no other account has the ${config.minTargetHeadroomPct}% headroom rotorcc requires`,
          fix:
            'If the active account hits its threshold now, rotorcc will checkpoint and refuse ' +
            'to rotate. That is deliberate, but it means the session ends. Add an account, ' +
            'lower minTargetHeadroomPct, or wait for a window to reset.',
        },
  );

  add({
    name: 'strategy',
    status: 'pass',
    detail:
      `${config.strategy}` +
      (config.refuseRotationWithUnsavedWork
        ? '; will refuse to rotate over work it cannot save'
        : '; will rotate even with unsaved work (refuseRotationWithUnsavedWork is off)'),
  });
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
