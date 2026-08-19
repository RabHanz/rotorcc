/**
 * `rotorcc purge` — remove everything rotorcc has put on this machine.
 *
 * Uninstalling a tool that stores credentials should not require an operator to
 * know where it hid them. But a command that deletes credentials is the most
 * dangerous one in the program, so it is built to three rules:
 *
 *   1. **It enumerates before it deletes.** Every path, with its size, and the
 *      count of logins that go with it. Without `--yes` that enumeration IS the
 *      command: nothing is removed, and the exit code says so.
 *   2. **It never touches Claude Code's own state.** Not `~/.claude/`, not
 *      `.credentials.json`, not `~/.claude.json`, not the keychain items Claude
 *      Code owns. rotorcc reads and writes those while it is running; deleting
 *      them here would log the operator out of a tool they did not uninstall.
 *      The paths are listed under "NOT touched" so that promise is checkable
 *      rather than merely stated.
 *   3. **It says what it cannot remove for you.** Hooks live inside a project's
 *      `settings.json` and a scheduler unit lives in the OS. Those are edits to
 *      files rotorcc does not own, so purge names them and gives the exact
 *      command instead of reaching in.
 */
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

import type { AccountManager } from '../accounts/manager.js';
import { slots } from '../accounts/roster.js';
import type { Config } from '../config/schema.js';
import { configPathFor } from '../config/load.js';
import {
  appPaths,
  claudeConfigHome,
  claudeCredentialsPath,
  claudeGlobalConfigPath,
} from '../core/paths.js';
import type { Store } from '../core/state.js';

export interface PurgeTarget {
  path: string;
  what: string;
  exists: boolean;
  bytes: number;
  /** Set when removing this loses something that cannot be recreated. */
  irreversible?: string;
}

export interface PurgeContext {
  config: Config;
  manager: AccountManager;
  store: Store;
  configPath?: string;
  yes: boolean;
  dryRun: boolean;
  json: boolean;
  out: (line: string) => void;
  /** Injected in tests so a run can never resolve a real home directory. */
  env?: NodeJS.ProcessEnv;
}

/** Recursive size of a file or directory, best effort. */
export function sizeOf(path: string, depth = 0): number {
  if (depth > 8 || !existsSync(path)) return 0;
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return 0;
  }
  if (!stat.isDirectory()) return stat.size;
  let total = 0;
  try {
    for (const entry of readdirSync(path)) total += sizeOf(join(path, entry), depth + 1);
  } catch {
    /* unreadable directory: reported as the bytes we could see */
  }
  return total;
}

export function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  // A transcript store reaches gigabytes on a machine that has been running
  // agents for a month. "6207.0 MB" is a number nobody reads as six gigabytes.
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * Everything purge would delete, whether it exists or not.
 *
 * Non-existent entries stay in the list on purpose. "That directory was already
 * gone" is information; silently shortening the list makes it look like rotorcc
 * kept less state than it does.
 */
export function purgeTargets(
  config: Config,
  manager: AccountManager,
  store: Store,
  /** The `--config` in force, so `purge --config X` deletes X and not the default. */
  configPath?: string,
  env: NodeJS.ProcessEnv = process.env,
): PurgeTarget[] {
  const paths = appPaths(env);
  const configFile = configPathFor(configPath, env);
  const accountsDir = config.accountsDir === '' ? paths.accountsDir : config.accountsDir;
  const accountCount = (() => {
    try {
      return slots(manager.roster.read()).length;
    } catch {
      return null;
    }
  })();

  const targets: PurgeTarget[] = [
    {
      path: accountsDir,
      what: 'accounts: the roster, every stored credential, the usage cache, directory mappings',
      exists: existsSync(accountsDir),
      bytes: sizeOf(accountsDir),
      irreversible:
        accountCount === null
          ? 'stored logins (the roster could not be read, so the count is unknown)'
          : `${accountCount} stored login(s) — you will have to run "claude /login" again for each`,
    },
    {
      path: store.dir,
      what: 'state: latches, flags, manifests, the decision journal, burn history, the log',
      exists: existsSync(store.dir),
      bytes: sizeOf(store.dir),
    },
    {
      path: config.storePath,
      what: 'the transcript store (a git repository holding your snapshotted sessions)',
      exists: existsSync(config.storePath),
      bytes: sizeOf(config.storePath),
      irreversible: 'every transcript snapshot rotorcc has taken, unless you mirrored it elsewhere',
    },
    {
      path: configFile,
      what: "rotorcc's config file",
      exists: existsSync(configFile),
      bytes: sizeOf(configFile),
    },
  ];

  const logFile = config.logging.file === '' ? paths.logFile : config.logging.file;
  if (!logFile.startsWith(store.dir)) {
    targets.push({
      path: logFile,
      what: 'the rotorcc log',
      exists: existsSync(logFile),
      bytes: sizeOf(logFile),
    });
  }
  return targets;
}

/** Files purge must never touch, listed so the promise can be checked. */
export function protectedPaths(
  config: Config,
  env: NodeJS.ProcessEnv = process.env,
): Array<{ path: string; what: string }> {
  const entries = [
    { path: claudeCredentialsPath(env), what: "Claude Code's own OAuth credential" },
    { path: claudeGlobalConfigPath(env), what: "Claude Code's global config" },
    { path: claudeConfigHome(env), what: "Claude Code's home, including your transcripts" },
    { path: config.claudeHome, what: 'the Claude Code home this config points at' },
  ];
  // The last two are usually the same directory reached two ways. Printing it
  // twice makes a short, load-bearing list look careless, and a list nobody
  // reads carefully is not a promise anybody can check.
  const seen = new Set<string>();
  return entries.filter((entry) => {
    if (seen.has(entry.path)) return false;
    seen.add(entry.path);
    return true;
  });
}

export function runPurge(ctx: PurgeContext): number {
  const targets = purgeTargets(ctx.config, ctx.manager, ctx.store, ctx.configPath, ctx.env);
  const protectedList = protectedPaths(ctx.config, ctx.env);
  const present = targets.filter((t) => t.exists);
  const totalBytes = present.reduce((sum, t) => sum + t.bytes, 0);

  const leftovers = [
    {
      what: "rotorcc's hooks inside each project's .claude/settings.json",
      how: ctx.config.projects
        .map((p) => `rotorcc uninstall-hooks ${p.path}`)
        .concat(['rotorcc uninstall-hooks --user'])
        .join('  |  '),
    },
    {
      what: 'the every-minute watcher (a systemd timer, launchd agent or scheduled task)',
      how: 'rotorcc uninstall-scheduler',
    },
  ];

  if (ctx.json) {
    ctx.out(
      JSON.stringify(
        {
          wouldDelete: targets,
          totalBytes,
          notTouched: protectedList,
          leftInPlace: leftovers,
          deleted: false,
          confirmed: ctx.yes,
        },
        null,
        2,
      ),
    );
    if (!ctx.yes || ctx.dryRun) return 1;
  } else {
    ctx.out('rotorcc purge — this would delete:');
    ctx.out('');
    for (const target of targets) {
      ctx.out(
        `  ${target.exists ? humanBytes(target.bytes).padStart(9) : 'not there'}  ${target.path}`,
      );
      ctx.out(`  ${' '.repeat(9)}  ${target.what}`);
      if (target.irreversible !== undefined && target.exists) {
        ctx.out(`  ${' '.repeat(9)}  IRREVERSIBLE: ${target.irreversible}`);
      }
    }
    ctx.out('');
    ctx.out(
      `  ${present.length} of ${targets.length} path(s) exist, ${humanBytes(totalBytes)} total`,
    );
    ctx.out('');
    ctx.out('NOT touched — these belong to Claude Code, not to rotorcc:');
    for (const item of protectedList) ctx.out(`  ${item.path}`);
    ctx.out('');
    ctx.out('Left in place, because they are edits to files rotorcc does not own:');
    for (const item of leftovers) {
      ctx.out(`  ${item.what}`);
      ctx.out(`    ${item.how}`);
    }
    ctx.out('');

    if (!ctx.yes) {
      ctx.out('Nothing was deleted. Re-run with --yes to actually do it.');
      ctx.out('If any of those logins are the only copy you have, export them first:');
      ctx.out('  rotorcc accounts export ~/rotorcc-accounts.json --yes');
      return 1;
    }
    if (ctx.dryRun) {
      ctx.out('DRY RUN — nothing was deleted.');
      return 1;
    }
  }

  if (ctx.dryRun) return 1;

  const removed: string[] = [];
  const failed: Array<{ path: string; error: string }> = [];
  for (const target of targets) {
    if (!target.exists) continue;
    try {
      rmSync(target.path, { recursive: true, force: true });
      removed.push(target.path);
    } catch (err) {
      failed.push({ path: target.path, error: (err as Error).message.slice(0, 160) });
    }
  }

  if (ctx.json) {
    ctx.out(JSON.stringify({ deleted: true, removed, failed }, null, 2));
  } else {
    for (const path of removed) ctx.out(`  removed  ${path}`);
    for (const failure of failed) ctx.out(`  FAILED   ${failure.path}: ${failure.error}`);
    ctx.out('');
    ctx.out(
      failed.length === 0
        ? `Purged. ${removed.length} path(s) removed; Claude Code's own state was not touched.`
        : `${removed.length} removed, ${failed.length} could NOT be removed — see above.`,
    );
  }
  return failed.length === 0 ? 0 : 1;
}
