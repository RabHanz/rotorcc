#!/usr/bin/env node
/**
 * The rotorcc command line.
 *
 * Hand-rolled rather than pulled from a framework: the whole surface is a dozen
 * verbs and six flags, and a dependency-free CLI is one fewer thing that can
 * break an install on a machine somebody is mid-crisis on.
 */
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ConfigError,
  configPathFor,
  getConfigValue,
  loadConfig,
  saveConfig,
  setConfigValue,
} from './config/load.js';
import type { Config } from './config/schema.js';
import { performCheckpoint } from './core/checkpoint.js';
import {
  type TickContext,
  type TickExitCode,
  exitCodeFor,
  loop,
  managerFor,
  readUsage,
  tick,
} from './core/daemon.js';
import type { Strategy } from './accounts/select.js';
import { Logger } from './core/log.js';
import { renderManifestMarkdown, parseManifest } from './core/manifest.js';
import { appPaths } from './core/paths.js';
import { applyPlan, schedulerPlan } from './core/scheduler.js';
import { FLAG_ROTATE_NOW, FLAG_SOFT_CHECKPOINT, Store } from './core/state.js';
import { VERSION } from './version.js';
import { runDoctor, renderDoctor } from './commands/doctor.js';
import { runHook } from './commands/hook.js';
import { runInit } from './commands/init.js';
import { install, uninstall } from './commands/installHooks.js';
import { buildStatus, renderStatus } from './commands/status.js';
import {
  addAccount,
  addToken,
  exportAccounts,
  importAccounts,
  importBundle,
  listAccounts,
  mapCommand,
  moveAccount,
  removeAccount,
  setAlias,
  setDisabled,
  swapAccounts,
  switchCommand,
  tokenStatus,
  unclaimedAccounts,
  unmapCommand,
} from './commands/accounts.js';
import { runPurge } from './commands/purge.js';
import { runUpgrade } from './commands/upgrade.js';
import { runPredict } from './commands/predict.js';
import { runAsAccount } from './commands/runAs.js';
import { runTui } from './tui/app.js';
import type { ThemeMode } from './tui/theme.js';

/** One place to print a usage line and return the conventional exit code. */
function usage(out: (line: string) => void, line: string): number {
  out(`usage: ${line}`);
  return 1;
}

/** The `daemon --once` contract, in one line each, for the human-readable form. */
const EXIT_MEANINGS: Record<TickExitCode, string> = {
  0: 'nothing to do',
  1: 'acted',
  2: 'would act, but could not',
  3: 'error',
};

interface Argv {
  command: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
}

/**
 * Flags that never take a value.
 *
 * Without this list, `rotorcc install-hooks --user /path` reads `/path` as the
 * value of `--user` and then reports no project. Guessing from what follows is
 * exactly the bug that makes CLIs annoying, so the boolean flags are declared.
 */
const BOOLEAN_FLAGS = new Set([
  'yes',
  'user',
  'dry-run',
  'json',
  'once',
  'inline',
  'verbose',
  'quiet',
  'clear',
  'help',
  'version',
  'force',
  'overwrite',
  'from-cswap',
  'unset',
  'check',
  'token-status',
  'unclaimed',
]);

export function parseArgv(argv: string[]): Argv {
  // `rotorcc --version` has no command; do not report "--version" as one.
  const leadsWithFlag = argv[0]?.startsWith('-') === true;
  const command = leadsWithFlag ? 'help' : (argv[0] ?? 'help');
  const rest = leadsWithFlag ? argv : argv.slice(1);
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i] as string;
    if (token === '-h' || token === '-v') {
      flags[token.slice(1)] = true;
    } else if (token.startsWith('--')) {
      const [name = '', inline] = token.slice(2).split('=', 2);
      if (inline !== undefined) {
        flags[name] = inline;
      } else if (BOOLEAN_FLAGS.has(name)) {
        flags[name] = true;
      } else {
        const next = rest[i + 1];
        if (next !== undefined && !next.startsWith('-')) {
          flags[name] = next;
          i += 1;
        } else {
          flags[name] = true;
        }
      }
    } else {
      positionals.push(token);
    }
  }
  return { command, positionals, flags };
}

/**
 * Exported so a test can assert that the contracts a script depends on — the
 * `daemon --once` exit codes above all — are actually documented where somebody
 * would look for them. Undocumented behaviour is behaviour nobody can rely on.
 */
export const HELP = `rotorcc ${VERSION} — zero-loss account rotation for long Claude Code sessions

usage: rotorcc <command> [options]

watching
  tui                       live dashboard: headroom, unsaved work, decisions
  watch                     the same dashboard (alias)
  status                    one screen, printed once
  predict                   when the active account runs out, and how sure

accounts
  accounts [list]           every managed account with its binding window
  accounts --token-status   which store each credential came from, and its expiry
  accounts unclaimed        stored credentials no account in the roster claims
  accounts unclaimed --purge <id>   delete exactly one of them (needs --yes)
  accounts add              capture the login Claude Code is using right now
  accounts add-token [-]    register a setup token or API key (- reads stdin)
  accounts remove <ref>     forget an account and its stored credential
  accounts alias <ref> <n>  give an account a short name (--unset to clear)
  accounts disable <ref>    hold it out of automatic rotation
  accounts enable <ref>     put it back
  accounts swap <a> <b>     exchange two slots
  accounts move <ref> <n>   put an account in a specific slot
  accounts import           bring in accounts from another switcher (--from-cswap)
  accounts export <path>    write a portable copy (contains real credentials)
  switch [ref]              change account now; without a ref, pick by strategy
  run <ref> [-- ...]        run one command as an account, this terminal only
  map [ref] [path]          bind a directory to an account; bare form lists them
  unmap [path]              remove a binding

setup
  init [path...]            detect this machine and write a config
  install-hooks <path>      add rotorcc's hooks to a project's settings (--user for user settings)
  uninstall-hooks <path>    remove them again
  install-scheduler         run the watcher every minute (systemd / launchd / Task Scheduler)
  uninstall-scheduler       stop it
  doctor                    check every assumption rotorcc makes, and say which are false
  upgrade [--check]         update rotorcc itself; --check only reports availability
  purge --yes               delete every file rotorcc owns (lists them first)

running
  daemon [--once]           watch account headroom and act on it
  snapshot                  copy transcripts into the store now
  push-unpushed             commit and push every watched worktree now
  manifest                  write a resume manifest now
  resume [--clear]          print the plan from the last manifest (--clear drops raised flags)

config
  config                    print the whole config
  config <key>              print one value, e.g. thresholds.rotatePct
  config set <key> <value>  set one value and re-validate
  config validate           check the config without changing it

internal
  hook <Event>              called by the installed hooks; reads a payload on stdin

options
  --config <path>           use a config other than the default
  --dry-run                 evaluate and report; never commit, push, mirror or switch
  --json                    machine-readable output; on every read command
  --yes                     take defaults, and confirm destructive actions
  --user                    act on the user settings file (install-hooks)
  --strategy <name>         work-aware | best | next-available | consume-first
  --model <names>           per-model weekly windows to count, or "all"
  --theme <name>            auto | dark | light | none (tui, watch)
  --force                   re-poll quota now, ignoring the poll floor
  --once                    one iteration and exit (daemon, tui)
  --slot <n>, --email <e>, --alias <a>   for accounts add / add-token
  -h, --help, -v, --version

exit codes for "daemon --once", so a cron job can branch on them
  0  nothing to do          headroom is fine; rotorcc changed nothing
  1  acted                  warned, checkpointed, queued a handover, or switched
  2  would act, but could not   refused, blocked, exhausted, or the lock was held
  3  error                  the tick could not complete, or an action failed
Under --dry-run the code reports what it WOULD have done; nothing is written.

"upgrade" exits 0 when already current or upgraded, 1 when an upgrade is
available (--check) or the upgrade failed, and 2 when it could not tell.

rotorcc never invents a number. An account it could not measure reports
"unknown" with the reason, and null in --json — never 0 and never 100.

The default config lives at:
  ${appPaths().configFile}
Accounts live at:
  ${appPaths().accountsDir}
`;

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

function contextFor(flags: Record<string, string | boolean>): {
  config: Config;
  store: Store;
  logger: Logger;
  dryRun: boolean;
  configPath: string | undefined;
} {
  const configPath = typeof flags.config === 'string' ? flags.config : undefined;
  const config = loadConfig(configPath);
  const paths = appPaths();
  const store = new Store(paths.stateDir);
  const dryRun = flags['dry-run'] === true || config.dryRun;
  const logger = new Logger({
    file: config.logging.file === '' ? paths.logFile : config.logging.file,
    level: flags.verbose === true ? 'debug' : config.logging.level,
    maxBytes: config.logging.maxBytes,
    console: true,
  });
  return { config, store, logger, dryRun, configPath };
}

/**
 * The path to record in a hook entry or a scheduler unit.
 *
 * Resolved through the symlink deliberately. A global npm install puts a link
 * on PATH, and links get replaced on upgrade or removed on uninstall; a hook
 * pointing at a dangling link fails silently every time the agent stops. The
 * real file survives both.
 */
function resolveBinary(): string {
  const entry = process.argv[1];
  if (entry === undefined) return 'rotorcc';
  try {
    return realpathSync(entry);
  } catch {
    return resolve(entry);
  }
}

async function main(): Promise<number> {
  const argv = parseArgv(process.argv.slice(2));
  const { command, positionals, flags } = argv;

  // Version first: `rotorcc --version` has no command, and the help fallback
  // below would otherwise swallow it and print the whole manual.
  if (flags.version === true || flags.v === true || command === 'version') {
    out(VERSION);
    return 0;
  }
  if (flags.help === true || flags.h === true || command === 'help') {
    out(HELP);
    return 0;
  }

  switch (command) {
    case 'hook': {
      const event = positionals[0] ?? '';
      const result = await runHook({
        event,
        configPath: typeof flags.config === 'string' ? flags.config : undefined,
        inline: flags.inline === true,
        payloadFile: typeof flags['payload-file'] === 'string' ? flags['payload-file'] : undefined,
      });
      if (result.stdout !== null) process.stdout.write(`${result.stdout}\n`);
      // A hook never blocks the tool loop, whatever went wrong inside it.
      return 0;
    }

    case 'init': {
      await runInit({
        configPath: typeof flags.config === 'string' ? flags.config : undefined,
        yes: flags.yes === true,
        projectPaths: positionals,
        cwd: process.cwd(),
        stdout: out,
      });
      return 0;
    }

    case 'install-hooks': {
      const ctx = contextFor(flags);
      install({
        projectPath: positionals[0] ?? ctx.config.projects[0]?.path,
        user: flags.user === true,
        binary: resolveBinary(),
        configPath: ctx.configPath,
        dryRun: ctx.dryRun,
        stdout: out,
      });
      return 0;
    }

    case 'uninstall-hooks': {
      const ctx = contextFor(flags);
      uninstall({
        projectPath: positionals[0] ?? ctx.config.projects[0]?.path,
        user: flags.user === true,
        binary: resolveBinary(),
        dryRun: ctx.dryRun,
        stdout: out,
      });
      return 0;
    }

    case 'install-scheduler':
    case 'uninstall-scheduler': {
      const ctx = contextFor(flags);
      const plan = schedulerPlan({
        // The node running this install, and the script it is running, both by
        // absolute path: a scheduled unit does not inherit this shell's PATH,
        // and a version-managed node is invisible without it.
        node: process.execPath,
        script: resolveBinary(),
        args: ctx.configPath === undefined ? [] : ['--config', ctx.configPath],
        pollSeconds: ctx.config.pollSeconds,
        path: process.env.PATH ?? '',
      });
      const uninstalling = command === 'uninstall-scheduler';
      out(`scheduler: ${plan.kind}`);
      const result = await applyPlan(
        uninstalling
          ? {
              ...plan,
              files: [],
              commands: plan.uninstallCommands,
            }
          : plan,
        ctx.dryRun,
      );
      for (const line of result.log) out(`  ${line}`);
      if (uninstalling && !ctx.dryRun) {
        for (const file of plan.uninstallFiles) {
          try {
            writeFileSync(file, '');
          } catch {
            /* already gone */
          }
        }
      }
      for (const note of plan.notes) out(`  note: ${note}`);
      return result.ok || plan.commands.length === 0 ? 0 : 1;
    }

    case 'daemon': {
      const ctx = contextFor(flags);
      const tickCtx: TickContext = {
        config: ctx.config,
        store: ctx.store,
        logger: ctx.logger,
        dryRun: ctx.dryRun,
      };
      if (flags.once === true) {
        const result = await tick(tickCtx);
        const code = exitCodeFor(result);
        // The code is in the JSON too. A caller that already parses the output
        // should not have to re-derive the one number it is going to branch on,
        // and re-deriving it is how the two drift apart.
        if (flags.json === true) out(JSON.stringify({ ...result, exitCode: code }, null, 2));
        else {
          out(result.detail);
          for (const action of result.actionsTaken) out(`  ${action}`);
          out(`exit ${code}: ${EXIT_MEANINGS[code]}`);
        }
        return code;
      }
      const controller = new AbortController();
      process.on('SIGINT', () => controller.abort());
      process.on('SIGTERM', () => controller.abort());
      await loop(tickCtx, controller.signal);
      return 0;
    }

    case 'snapshot': {
      const ctx = contextFor(flags);
      const result = await performCheckpoint({
        config: ctx.config,
        store: ctx.store,
        logger: ctx.logger,
        trigger: 'manual:snapshot',
        dryRun: ctx.dryRun,
        skipLanes: true,
      });
      const snap = result.snapshot;
      if (flags.json === true) out(JSON.stringify(snap, null, 2));
      else if (snap !== null) {
        out(`${snap.filesCopied} file(s) copied, ${snap.bytesCopied} new byte(s)`);
        out(`commit: ${snap.commit ?? 'nothing to commit'}`);
        out(`mirror: ${snap.mirror.detail}`);
        if (snap.secretHits.length > 0) {
          out(`secrets screen: ${snap.secretHits.length} hit(s); mirror refused`);
          for (const hit of snap.secretHits.slice(0, 10)) {
            out(`  ${hit.patternId} in ${hit.file}: ${hit.excerpt}`);
          }
        }
      }
      return 0;
    }

    case 'push-unpushed': {
      const ctx = contextFor(flags);
      const result = await performCheckpoint({
        config: ctx.config,
        store: ctx.store,
        logger: ctx.logger,
        trigger: 'manual:push-unpushed',
        dryRun: ctx.dryRun,
        skipSnapshot: true,
      });
      if (flags.json === true) {
        out(JSON.stringify(result.projects, null, 2));
      } else {
        for (const project of result.projects) {
          out(project.project);
          for (const outcome of project.outcomes) {
            const state =
              outcome.error !== null
                ? `ERROR ${outcome.error}`
                : outcome.skipped !== null
                  ? `skipped: ${outcome.skipped}`
                  : `${outcome.committed ? 'committed' : 'clean'}${outcome.pushed ? ' + pushed' : ''}`;
            out(`  ${outcome.branch.padEnd(40)} ${state}`);
          }
        }
      }
      return 0;
    }

    case 'manifest': {
      const ctx = contextFor(flags);
      const usage = await readUsage(ctx.config);
      const result = await performCheckpoint({
        config: ctx.config,
        store: ctx.store,
        logger: ctx.logger,
        trigger: 'manual:manifest',
        dryRun: ctx.dryRun,
        usage: 'error' in usage ? undefined : usage,
        writeManifest: true,
        cleanExit: true,
      });
      out(result.manifestPath ?? 'no manifest written');
      if (result.manifestMarkdownPath !== null) out(result.manifestMarkdownPath);
      return 0;
    }

    case 'status': {
      const ctx = contextFor(flags);
      const report = await buildStatus(ctx.config, ctx.store, readUsage);
      if (flags.json === true) out(JSON.stringify(report, null, 2));
      else process.stdout.write(renderStatus(report, ctx.config));
      return 0;
    }

    case 'tui':
    case 'watch': {
      const ctx = contextFor(flags);
      return runTui({
        config: ctx.config,
        store: ctx.store,
        manager: managerFor(ctx.config),
        dryRun: ctx.dryRun,
        force: flags.force === true,
        once: flags.once === true,
        ...(typeof flags.theme === 'string' ? { theme: flags.theme as ThemeMode } : {}),
      });
    }

    case 'predict': {
      const ctx = contextFor(flags);
      return runPredict({
        config: ctx.config,
        store: ctx.store,
        manager: managerFor(ctx.config),
        json: flags.json === true,
        force: flags.force === true,
        out,
      });
    }

    case 'accounts': {
      const ctx = contextFor(flags);
      const accountsCtx = {
        config: ctx.config,
        manager: managerFor(ctx.config),
        dryRun: ctx.dryRun,
        json: flags.json === true,
        yes: flags.yes === true,
        out,
      };
      const sub = positionals[0] ?? 'list';
      const ref = positionals[1];
      const numberFlag = (name: string): number | undefined => {
        const raw = flags[name];
        if (typeof raw !== 'string') return undefined;
        const value = Number.parseInt(raw, 10);
        return Number.isInteger(value) ? value : undefined;
      };

      // `--token-status` reads as a modifier of the account listing rather than
      // a verb, so it is a flag on any accounts form rather than a subcommand.
      if (flags['token-status'] === true) return tokenStatus(accountsCtx);

      switch (sub) {
        case 'list':
          return listAccounts(accountsCtx, flags.force === true);
        case 'unclaimed':
          return unclaimedAccounts(accountsCtx, {
            ...(typeof flags.purge === 'string' ? { purge: flags.purge } : {}),
          });
        case 'add':
          return addAccount(accountsCtx, {
            ...(numberFlag('slot') !== undefined ? { slot: numberFlag('slot') as number } : {}),
            ...(typeof flags.email === 'string' ? { email: flags.email } : {}),
            ...(typeof flags.alias === 'string' ? { alias: flags.alias } : {}),
          });
        case 'add-token':
          return addToken(accountsCtx, {
            ...(ref !== undefined ? { token: ref } : {}),
            ...(numberFlag('slot') !== undefined ? { slot: numberFlag('slot') as number } : {}),
            ...(typeof flags.email === 'string' ? { email: flags.email } : {}),
            ...(typeof flags.alias === 'string' ? { alias: flags.alias } : {}),
          });
        case 'remove':
          if (ref === undefined) return usage(out, 'rotorcc accounts remove <slot|email|alias>');
          return removeAccount(accountsCtx, ref);
        case 'alias': {
          if (ref === undefined) return listAccounts(accountsCtx);
          const name = flags.unset === true ? '--unset' : positionals[2];
          if (name === undefined) return usage(out, 'rotorcc accounts alias <ref> <name|--unset>');
          return setAlias(accountsCtx, ref, name);
        }
        case 'disable':
        case 'enable':
          if (ref === undefined) return usage(out, `rotorcc accounts ${sub} <slot|email|alias>`);
          return setDisabled(accountsCtx, ref, sub === 'disable');
        case 'swap': {
          const other = positionals[2];
          if (ref === undefined || other === undefined) {
            return usage(out, 'rotorcc accounts swap <a> <b>');
          }
          return swapAccounts(accountsCtx, ref, other);
        }
        case 'move': {
          const target = positionals[2];
          if (ref === undefined || target === undefined) {
            return usage(out, 'rotorcc accounts move <ref> <slot>');
          }
          const slot = Number.parseInt(target, 10);
          if (!Number.isInteger(slot)) return usage(out, 'the target slot must be a number');
          return moveAccount(accountsCtx, ref, slot);
        }
        case 'import':
          return importAccounts(accountsCtx, {
            ...(typeof flags.from === 'string' ? { from: flags.from } : {}),
            overwrite: flags.overwrite === true,
          });
        case 'import-bundle':
          if (ref === undefined) return usage(out, 'rotorcc accounts import-bundle <path>');
          return importBundle(accountsCtx, ref);
        case 'export':
          if (ref === undefined) return usage(out, 'rotorcc accounts export <path>');
          return exportAccounts(accountsCtx, ref);
        default:
          out(`unknown accounts command: ${sub}`);
          return 1;
      }
    }

    case 'switch': {
      const ctx = contextFor(flags);
      return switchCommand(
        {
          config: ctx.config,
          manager: managerFor(ctx.config),
          dryRun: ctx.dryRun,
          json: flags.json === true,
          yes: flags.yes === true,
          out,
        },
        {
          ...(positionals[0] !== undefined ? { identifier: positionals[0] } : {}),
          strategy: (typeof flags.strategy === 'string'
            ? flags.strategy
            : ctx.config.strategy) as Strategy,
          force: flags.force === true,
        },
      );
    }

    case 'run': {
      const ctx = contextFor(flags);
      return runAsAccount({
        config: ctx.config,
        manager: managerFor(ctx.config),
        identifier: positionals[0],
        argv: process.argv.slice(2),
        dryRun: ctx.dryRun,
        out,
      });
    }

    case 'map': {
      const ctx = contextFor(flags);
      return mapCommand(
        {
          config: ctx.config,
          manager: managerFor(ctx.config),
          dryRun: ctx.dryRun,
          json: flags.json === true,
          yes: flags.yes === true,
          out,
        },
        {
          ...(positionals[0] !== undefined ? { identifier: positionals[0] } : {}),
          ...(positionals[1] !== undefined ? { path: positionals[1] } : {}),
        },
      );
    }

    case 'unmap': {
      const ctx = contextFor(flags);
      return unmapCommand(
        {
          config: ctx.config,
          manager: managerFor(ctx.config),
          dryRun: ctx.dryRun,
          json: flags.json === true,
          yes: flags.yes === true,
          out,
        },
        positionals[0],
      );
    }

    case 'resume': {
      const ctx = contextFor(flags);
      const latest = ctx.store.latestManifest();
      if (latest === null) {
        out('no manifest has been written yet');
        return 1;
      }
      const manifest = parseManifest(JSON.parse(readFileSync(latest, 'utf8')));
      process.stdout.write(renderManifestMarkdown(manifest));
      if (flags.clear === true) {
        ctx.store.clearFlag(FLAG_ROTATE_NOW);
        ctx.store.clearFlag(FLAG_SOFT_CHECKPOINT);
        out('');
        out('flags cleared');
      }
      return 0;
    }

    case 'upgrade': {
      const ctx = contextFor(flags);
      const result = await runUpgrade({
        binaryPath: resolveBinary(),
        check: flags.check === true,
        dryRun: ctx.dryRun,
        json: flags.json === true,
        config: ctx.config,
        store: ctx.store,
        ...(ctx.configPath === undefined ? {} : { configPath: ctx.configPath }),
        // `repoRoot` is deliberately NOT exposed as a flag. It skips the .git
        // and package-name checks that stop this command fast-forwarding and
        // renaming dist/ inside somebody's unrelated project, and a mistyped
        // path is not a thing to find out about afterwards.
        out,
      });
      return result.code;
    }

    case 'purge': {
      const ctx = contextFor(flags);
      return runPurge({
        config: ctx.config,
        manager: managerFor(ctx.config),
        store: ctx.store,
        ...(ctx.configPath === undefined ? {} : { configPath: ctx.configPath }),
        yes: flags.yes === true,
        dryRun: ctx.dryRun,
        json: flags.json === true,
        out,
      });
    }

    case 'doctor': {
      const ctx = contextFor(flags);
      const checks = await runDoctor(ctx.config, ctx.store, ctx.configPath);
      if (flags.json === true) out(JSON.stringify(checks, null, 2));
      else process.stdout.write(renderDoctor(checks));
      return checks.some((c) => c.status === 'fail') ? 1 : 0;
    }

    case 'config': {
      const configPath = configPathFor(typeof flags.config === 'string' ? flags.config : undefined);
      const sub = positionals[0];
      if (sub === 'set') {
        const key = positionals[1];
        const value = positionals[2];
        if (key === undefined || value === undefined) {
          out('usage: rotorcc config set <key> <value>');
          return 1;
        }
        const next = setConfigValue(loadConfig(configPath), key, value);
        saveConfig(next, configPath);
        out(`${key} = ${JSON.stringify(getConfigValue(next, key))}`);
        return 0;
      }
      if (sub === 'validate') {
        loadConfig(configPath);
        out(`${configPath} is valid`);
        return 0;
      }
      const config = loadConfig(configPath);
      if (sub === undefined) out(JSON.stringify(config, null, 2));
      else out(JSON.stringify(getConfigValue(config, sub), null, 2));
      return 0;
    }

    default:
      out(`unknown command: ${command}`);
      out('');
      out(HELP);
      return 1;
  }
}

/**
 * True when this file is the program being run, rather than an import.
 *
 * Both sides go through `realpathSync`, and that is the whole point: a global
 * npm install puts a SYMLINK on the PATH, so `process.argv[1]` is the link and
 * `import.meta.url` is the target. Comparing them unresolved makes every
 * globally installed copy start up, do nothing, and exit 0 — which is exactly
 * what happened the first time this was installed for real.
 */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  const canonical = (path: string): string => {
    try {
      return realpathSync(path);
    } catch {
      return resolve(path);
    }
  };
  return canonical(entry) === canonical(fileURLToPath(import.meta.url));
}

const isDirectRun = isEntryPoint();

if (isDirectRun) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      if (err instanceof ConfigError) {
        process.stderr.write(`rotorcc: ${err.message}\n`);
        process.exitCode = 2;
        return;
      }
      process.stderr.write(`rotorcc: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    });
}

export { main };
