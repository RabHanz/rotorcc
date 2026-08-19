/**
 * `rotorcc run <ref> [-- command...]` — run one command as an account, without
 * changing what the rest of the machine is using.
 *
 * The mechanism is `CLAUDE_CONFIG_DIR`. rotorcc materialises a throwaway config
 * home containing just that account's credential and identity, points the child
 * process at it, and deletes it when the child exits. Nothing global is
 * touched: another terminal running Claude Code carries on with whatever it
 * was using, and rotorcc's own idea of the active account does not move.
 *
 * Three properties this has to have, in order of how badly it goes wrong
 * without them:
 *
 *   1. **The temp home is 0700 and is removed on every exit path**, including
 *      a signal. It holds a real credential for as long as the child runs.
 *   2. **The child's exit code passes through.** `rotorcc run 2 -- claude -p …`
 *      inside a script has to fail when the command fails.
 *   3. **No credential is ever put in argv or in an environment variable.** It
 *      goes to a file with a mode, which is the only place it goes.
 *
 * With no `--` and no command, this prints the environment to export instead of
 * running anything, so it can be used from a shell that wants to keep the
 * setting for a whole session.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Config } from '../config/schema.js';
import type { AccountManager } from '../accounts/manager.js';
import { ensurePrivateDir, writeFileAtomic, writeJsonAtomic } from '../accounts/atomic.js';
import { MappingStore } from '../accounts/mappings.js';
import { resolveIdentifier, slotLabel } from '../accounts/roster.js';

export interface RunAsOptions {
  config: Config;
  manager: AccountManager;
  /** Slot, email or alias. When omitted, the mapping for the cwd is used. */
  identifier?: string | undefined;
  /** The raw process argv from position 0 of the command, to find `--`. */
  argv: string[];
  dryRun: boolean;
  out: (line: string) => void;
}

export async function runAsAccount(options: RunAsOptions): Promise<number> {
  const { manager, out } = options;

  let identifier = options.identifier;
  if (identifier === undefined) {
    // `rotorcc run` with no account: use the directory's binding. That is the
    // whole point of `map` — the repository decides, not the operator's memory.
    const mapped = new MappingStore(manager.accountsDir).resolve(process.cwd());
    if (mapped === null) {
      out('no account given, and this directory is not mapped to one.');
      out('Either name an account, or bind this directory:  rotorcc map <ref>');
      return 1;
    }
    identifier = String(mapped.slot);
    out(`using slot ${mapped.slot}, mapped via ${mapped.via}`);
  }

  const resolved = resolveIdentifier(manager.roster.read(), identifier);
  if (resolved.kind === 'ambiguous') {
    out(`"${identifier}" matches more than one account. Use the slot number.`);
    return 1;
  }
  if (resolved.kind === 'not-found') {
    out(`no account matches "${identifier}"`);
    return 1;
  }
  const slot = resolved.slot;

  const stash = await manager.credentials.readStash(slot.slot, slot.email);
  if (stash.kind !== 'found') {
    out(
      stash.kind === 'absent'
        ? `rotorcc holds no credential for slot ${slot.slot}`
        : `slot ${slot.slot}'s credential could not be read: ${stash.detail}`,
    );
    return 1;
  }

  // Everything after a bare `--` is the command. Without one, there is no
  // command and we print the environment instead.
  const separator = options.argv.indexOf('--');
  const command = separator === -1 ? [] : options.argv.slice(separator + 1);

  if (options.dryRun) {
    out(
      `DRY RUN — would run ${command.length === 0 ? '(nothing)' : command.join(' ')} ` +
        `as slot ${slot.slot} (${slotLabel(slot)}) in a throwaway config home.`,
    );
    return 0;
  }

  const home = mkdtempSync(join(tmpdir(), 'rotorcc-run-'));
  ensurePrivateDir(home);
  // The export-only mode hands the directory to the caller's shell, so it must
  // outlive this process. Every other path cleans up unconditionally.
  let keepHome = false;
  try {
    writeFileAtomic(join(home, '.credentials.json'), stash.value, { mode: 0o600 });
    const identity = manager.credentials.readAccountIdentity(slot.slot, slot.email);
    // `.claude.json` lives beside the config home when CLAUDE_CONFIG_DIR is
    // set, so it goes inside the temp directory too.
    writeJsonAtomic(
      join(home, '.claude.json'),
      identity === null ? {} : { oauthAccount: identity },
    );

    if (command.length === 0) {
      keepHome = true;
      out('');
      out(`# slot ${slot.slot} (${slotLabel(slot)}) — this shell only`);
      out(`export CLAUDE_CONFIG_DIR=${home}`);
      out('');
      out('# That directory holds a real credential and is NOT cleaned up in this mode,');
      out('# because your shell still needs it. Remove it when you are done:');
      out(`#   rm -rf ${home}`);
      return 0;
    }

    const [head, ...rest] = command;
    if (head === undefined) return 1;

    const code = await new Promise<number>((resolve) => {
      const child = spawn(head, rest, {
        stdio: 'inherit',
        env: { ...process.env, CLAUDE_CONFIG_DIR: home },
      });
      child.on('error', (err) => {
        out(`could not run ${head}: ${err.message}`);
        resolve(127);
      });
      // A signalled child reports 128+signal, the shell convention, so a script
      // wrapping this can tell a crash from a non-zero exit.
      child.on('close', (exitCode, signal) =>
        resolve(exitCode ?? (signal === null ? 1 : 128 + signalNumber(signal))),
      );
    });
    return code;
  } finally {
    // Runs on a normal exit, an exception, and a rejected promise. A credential
    // left in /tmp because a command threw is not an acceptable failure mode.
    if (!keepHome) {
      try {
        rmSync(home, { recursive: true, force: true });
      } catch {
        out(`warning: could not remove ${home}, which holds a credential. Delete it by hand.`);
      }
    }
  }
}

function signalNumber(signal: NodeJS.Signals): number {
  const table: Partial<Record<NodeJS.Signals, number>> = {
    SIGHUP: 1,
    SIGINT: 2,
    SIGQUIT: 3,
    SIGKILL: 9,
    SIGTERM: 15,
  };
  return table[signal] ?? 1;
}
