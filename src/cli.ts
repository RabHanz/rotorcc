#!/usr/bin/env node
/**
 * The rotorcc command line.
 *
 * Hand-rolled rather than pulled from a framework: the whole surface is a dozen
 * verbs and six flags, and a dependency-free CLI is one fewer thing that can
 * break an install on a machine somebody is mid-crisis on.
 */
import { readFileSync, writeFileSync } from 'node:fs';
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
import { type TickContext, loop, readUsage, tick } from './core/daemon.js';
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

interface Argv {
  command: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
}

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
      } else {
        const next = rest[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
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

const HELP = `rotorcc ${VERSION} — zero-loss account rotation for long Claude Code sessions

usage: rotorcc <command> [options]

setup
  init [path...]            detect this machine and write a config
  install-hooks <path>      add rotorcc's hooks to a project's settings (--user for user settings)
  uninstall-hooks <path>    remove them again
  install-scheduler         run the watcher every minute (systemd / launchd / Task Scheduler)
  uninstall-scheduler       stop it
  doctor                    check every assumption rotorcc makes

running
  daemon [--once]           watch account headroom and act on it
  snapshot                  copy transcripts into the store now
  push-unpushed             commit and push every watched worktree now
  manifest                  write a resume manifest now
  status                    one screen: headroom, backups, unsaved work
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
  --json                    machine-readable output where it makes sense
  --yes                     take defaults instead of asking (init)
  --user                    act on the user settings file (install-hooks)
  -h, --help, -v, --version

The default config lives at:
  ${appPaths().configFile}
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

function resolveBinary(): string {
  const entry = process.argv[1];
  if (entry === undefined) return 'rotorcc';
  return resolve(entry);
}

async function main(): Promise<number> {
  const argv = parseArgv(process.argv.slice(2));
  const { command, positionals, flags } = argv;

  if (flags.help === true || flags.h === true || command === 'help') {
    out(HELP);
    return 0;
  }
  if (flags.version === true || flags.v === true || command === 'version') {
    out(VERSION);
    return 0;
  }

  switch (command) {
    case 'hook': {
      const event = positionals[0] ?? '';
      const result = await runHook({
        event,
        configPath: typeof flags.config === 'string' ? flags.config : undefined,
        inline: flags.inline === true,
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
        binary: resolveBinary(),
        args: ctx.configPath === undefined ? [] : ['--config', ctx.configPath],
        pollSeconds: ctx.config.pollSeconds,
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
        if (flags.json === true) out(JSON.stringify(result, null, 2));
        else {
          out(result.detail);
          for (const action of result.actionsTaken) out(`  ${action}`);
        }
        return result.ok ? 0 : 1;
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

const isDirectRun =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

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
