/**
 * Switching the active account.
 *
 * Five steps, each recorded, each undoable, all of them inside Claude Code's
 * own credential and config locks:
 *
 *   1. capture   read the live credential and identity, and stash them back
 *                onto the slot they belong to
 *   2. load      read the target slot's credential and identity
 *   3. activate  write the target credential as the live one
 *   4. identify  splice the target's `oauthAccount` into Claude Code's config
 *   5. record    update the roster's `activeSlot`
 *
 * Step 1 is the one people skip and the one that loses accounts. Claude Code
 * rotates the live account's refresh token whenever it likes; the copy rotorcc
 * stashed when the slot was added is dead the moment that happens. Capturing
 * before switching away is the only thing that keeps the slot loggable-in.
 *
 * Rollback runs the recorded steps in reverse. It is best-effort by nature —
 * if writing the credential failed, writing it back may fail too — but the
 * outcome is REPORTED rather than swallowed, because "the switch failed and so
 * did the rollback" is a state a human must be told about immediately.
 *
 * Nothing here logs a credential. The `detail` strings carry slot numbers,
 * emails and fingerprints only.
 */
import { withClaudeConfigLock, withClaudeCredentialsLock } from './ccLock.js';
import {
  type CredentialStore,
  type Secret,
  composeForActivation,
  credentialFingerprint,
} from './credentials.js';
import { type RosterSlot, type RosterStore, slots } from './roster.js';

export interface SwitchResult {
  ok: boolean;
  fromSlot: number | null;
  toSlot: number;
  /** Steps that completed, in order. Present on failure too. */
  steps: string[];
  /** Whether a failed switch was fully undone. Null when nothing was attempted. */
  rolledBack: boolean | null;
  detail: string;
  /** Non-fatal things an operator should know about. */
  warnings: string[];
}

export interface SwitchOptions {
  roster: RosterStore;
  credentials: CredentialStore;
  target: RosterSlot;
  dryRun?: boolean;
  /** Lock acquisition budget; the two credential locks each get this. */
  lockTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export async function switchAccount(options: SwitchOptions): Promise<SwitchResult> {
  const { roster, credentials, target } = options;
  const warnings: string[] = [];
  const steps: string[] = [];

  const table = roster.read();
  const known = slots(table);
  if (!known.some((s) => s.slot === target.slot)) {
    return {
      ok: false,
      fromSlot: table.activeSlot,
      toSlot: target.slot,
      steps,
      rolledBack: null,
      detail: `slot ${target.slot} is not in the roster`,
      warnings,
    };
  }

  // Read the target's stash BEFORE touching anything live. A slot with no
  // stored credential cannot be switched to, and discovering that after the
  // live credential has already been cleared would leave the machine with no
  // login at all.
  const targetStash = await credentials.readStash(target.slot, target.email);
  if (targetStash.kind !== 'found') {
    return {
      ok: false,
      fromSlot: table.activeSlot,
      toSlot: target.slot,
      steps,
      rolledBack: null,
      detail:
        targetStash.kind === 'absent'
          ? `rotorcc holds no credential for slot ${target.slot}; re-add it with "rotorcc accounts add"`
          : `slot ${target.slot}'s credential could not be read: ${targetStash.detail}`,
      warnings,
    };
  }
  const targetIdentity = credentials.readAccountIdentity(target.slot, target.email);
  if (targetIdentity === null) {
    warnings.push(
      `slot ${target.slot} has no stored account identity; Claude Code's config will keep the ` +
        'previous one until this account is next captured',
    );
  }

  if (options.dryRun === true) {
    return {
      ok: true,
      fromSlot: table.activeSlot,
      toSlot: target.slot,
      steps: ['dry-run: nothing was written'],
      rolledBack: null,
      detail:
        `DRY RUN — would switch to slot ${target.slot} (${target.email}). ` +
        'No credential, config or roster file was touched.',
      warnings,
    };
  }

  const live = await credentials.readActive();
  const liveFingerprint = live.kind === 'found' ? credentialFingerprint(live.value) : null;
  const liveConfig = credentials.readGlobalConfig();
  const liveIdentity = liveConfig?.oauthAccount ?? null;

  // Which slot the live credential belongs to, by fingerprint. Not the roster's
  // opinion — if someone logged in by hand, the roster is wrong and capturing
  // onto the slot it names would overwrite a good credential with a stranger's.
  let fromSlot: RosterSlot | null = null;
  if (liveFingerprint !== null) {
    for (const candidate of known) {
      const stash = await credentials.readStash(candidate.slot, candidate.email);
      if (stash.kind === 'found' && credentialFingerprint(stash.value) === liveFingerprint) {
        fromSlot = candidate;
        break;
      }
    }
    if (fromSlot === null) {
      warnings.push(
        'the credential currently active does not belong to any account rotorcc manages; ' +
          'it will NOT be captured, and switching away will leave it only wherever Claude Code ' +
          'keeps it. Add it first if you want to come back to it.',
      );
    }
  } else if (live.kind === 'unreadable') {
    warnings.push(
      `the live credential could not be read (${live.detail}), so the account being left cannot ` +
        'be captured. Its stored copy may now be a generation behind.',
    );
  }

  // A rollback record. Only what is needed to put the machine back, and it
  // lives on the stack: nothing here is ever written to disk.
  const undo: Array<{ step: string; run: () => Promise<void> }> = [];
  // Whether the target credential actually became live. Tracked separately from
  // `undo` because the failure message an operator acts on turns on this exact
  // fact, and inferring it from the rollback stack is how it got inferred wrong.
  let activated = false;

  const result = await withClaudeCredentialsLock(
    async () =>
      withClaudeConfigLock(
        async () => {
          try {
            // Step 1 — capture the account being left.
            if (fromSlot !== null && live.kind === 'found') {
              if (live.degraded) {
                // These bytes may be a superseded generation. Writing them over
                // the slot's stash would replace a live refresh token with a
                // spent one, which is unrecoverable. Skip and say so.
                warnings.push(
                  `slot ${fromSlot.slot}'s live credential was read from a fallback backend and ` +
                    'may be stale, so it was NOT captured. Its stored copy was left alone.',
                );
              } else {
                await credentials.writeStash(fromSlot.slot, fromSlot.email, live.value);
                steps.push(`captured slot ${fromSlot.slot}`);
              }
              if (liveIdentity !== null) {
                credentials.writeAccountIdentity(fromSlot.slot, fromSlot.email, liveIdentity);
              }
            }

            // Step 2/3 — activate the target, with the machine's current shared
            // fields spliced in so a switch does not roll MCP state backwards.
            const composed: Secret = composeForActivation(
              targetStash.value,
              live.kind === 'found' ? live.value : null,
            );
            const backend = await credentials.writeActive(composed);
            activated = true;
            steps.push(`activated slot ${target.slot} (${backend})`);

            // An undo entry is pushed for the credential write WHATEVER the
            // previous state was — that is what makes `undo.length === 0` mean
            // "nothing was written", which the failure path below relies on to
            // choose its message.
            //
            // Registering it only when there was a previous credential to
            // restore was a real defect: an operator with no live login (logged
            // out, or the file transiently unreadable) whose switch then failed
            // at step 4 or 5 was told "switch failed before anything was
            // written", while Claude Code was already running as the target.
            if (live.kind === 'found') {
              const previous = live.value;
              undo.push({
                step: 'credential',
                run: async () => {
                  await credentials.writeActive(previous);
                },
              });
            } else {
              // There was nothing to put back. Record the step anyway so the
              // caller cannot be told nothing happened; the rollback itself is
              // a no-op that reports honestly.
              undo.push({
                step: 'credential',
                run: async () => {
                  throw new Error(
                    'the target credential was activated and there was no previous ' +
                      'credential to restore; this machine is now on the target account',
                  );
                },
              });
            }

            // Step 4 — the identity block only. Never the whole config: it is
            // the file holding every project, MCP server and setting on the
            // machine, and swapping it wholesale loses whichever copy was newer.
            if (targetIdentity !== null) {
              const before = liveIdentity;
              credentials.updateGlobalConfig((config) => {
                config.oauthAccount = targetIdentity;
              });
              steps.push('updated Claude Code identity');
              undo.push({
                step: 'identity',
                run: async () => {
                  credentials.updateGlobalConfig((config) => {
                    if (before === null) delete config.oauthAccount;
                    else config.oauthAccount = before;
                  });
                  return Promise.resolve();
                },
              });
            }

            // Step 5 — record it.
            const beforeActive = table.activeSlot;
            roster.update((r) => {
              r.activeSlot = target.slot;
            });
            steps.push('recorded active slot');
            undo.push({
              step: 'roster',
              run: async () => {
                roster.update((r) => {
                  r.activeSlot = beforeActive;
                });
                return Promise.resolve();
              },
            });

            return { failure: null as Error | null };
          } catch (err) {
            return { failure: err instanceof Error ? err : new Error(String(err)) };
          }
        },
        // `env` has to reach BOTH locks. Without it the config lock resolves
        // against the real process environment while the credential lock uses
        // the caller's, which means a test — or a `rotorcc run` with a
        // redirected CLAUDE_CONFIG_DIR — takes a lock in one home directory
        // and mutates files in another.
        {
          ...(options.lockTimeoutMs !== undefined ? { timeoutMs: options.lockTimeoutMs } : {}),
          ...(options.env !== undefined ? { env: options.env } : {}),
        },
      ),
    {
      ...(options.lockTimeoutMs !== undefined ? { timeoutMs: options.lockTimeoutMs } : {}),
      ...(options.env !== undefined ? { env: options.env } : {}),
    },
  );

  if (result.failure === null) {
    return {
      ok: true,
      fromSlot: fromSlot?.slot ?? null,
      toSlot: target.slot,
      steps,
      rolledBack: null,
      detail: `switched to slot ${target.slot} (${target.email})`,
      warnings,
    };
  }

  // `activated` and not `undo.length`, because those are different questions and
  // only one of them is the one the operator acts on. "Nothing was written" is a
  // claim about the machine's state, and making it after the target credential
  // is already live sends someone to investigate a switch that has in fact
  // happened.
  if (!activated && undo.length === 0) {
    return {
      ok: false,
      fromSlot: fromSlot?.slot ?? null,
      toSlot: target.slot,
      steps,
      rolledBack: null,
      detail: `switch failed before anything was written: ${result.failure.message}`,
      warnings,
    };
  }

  let rolledBack = true;
  for (const entry of [...undo].reverse()) {
    try {
      await entry.run();
    } catch (err) {
      rolledBack = false;
      warnings.push(`rollback of "${entry.step}" failed: ${(err as Error).message.slice(0, 160)}`);
    }
  }

  return {
    ok: false,
    fromSlot: fromSlot?.slot ?? null,
    toSlot: target.slot,
    steps,
    rolledBack,
    detail: rolledBack
      ? `switch failed and was rolled back: ${result.failure.message}`
      : `switch failed AND rollback failed: ${result.failure.message}. ` +
        'This machine may be between accounts — check "rotorcc accounts" and re-login if needed.',
    warnings,
  };
}
