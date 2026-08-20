/**
 * What the dashboard's keys actually do.
 *
 * Every action here is a thin adapter over the command function the CLI verb
 * already calls. `s` runs `switchCommand`, the same one `rotorcc switch <ref>`
 * runs. `d` runs `setDisabled`, the same one `rotorcc accounts disable` runs.
 * `t` runs `setConfigValue` + `saveConfig`, the same pair `rotorcc config set`
 * runs. `c` runs `performCheckpoint`, the same one the watcher and
 * `rotorcc push-unpushed` run.
 *
 * That is the whole design. A TUI that reimplements its own switch has two
 * switch implementations, and the one nobody tests is the one that runs at
 * three in the morning when an account is about to expire. There is one
 * implementation and one set of tests; this file only captures its output and
 * turns its exit code into something the pane can draw.
 *
 * ## The lock
 *
 * Every mutating action takes rotorcc's own `tick` lock first. The watcher runs
 * every sixty seconds and holds that lock while it decides and acts, so without
 * this an operator pressing `s` at the wrong second would be switching
 * credentials underneath a tick that is halfway through switching them itself.
 * A lock we could not take is reported as a refusal to act — never as an action
 * that quietly did nothing.
 */
import type { Config } from '../config/schema.js';
import type { AccountManager } from '../accounts/manager.js';
import { setDisabled, switchCommand } from '../commands/accounts.js';
import { configPathFor, loadConfig, saveConfig, setConfigValue } from '../config/load.js';
import { performCheckpoint } from '../core/checkpoint.js';
import type { Logger } from '../core/log.js';
import { FLAG_ROTATE_NOW, FLAG_SOFT_CHECKPOINT, type Store } from '../core/state.js';
import type { ActionOutcome, PendingAction } from './interaction.js';

export interface ActionContext {
  config: Config;
  store: Store;
  manager: AccountManager;
  logger: Logger;
  dryRun: boolean;
  configPath: string | undefined;
  now?: () => Date;
}

/**
 * The staleness a TUI action allows before it will break somebody else's lock.
 *
 * Effectively never. `Store.acquireLock` breaks a held lock for either of two
 * reasons: the owning process is gone, or the lock is older than this. The
 * first is correct and desirable — a killed watcher must not block a keypress
 * forever. The second is a guess, and the guess is wrong in exactly the case
 * that matters: a tick holds this lock for its whole decide-and-act phase,
 * which includes a checkpoint sweep with pushes over every watched worktree,
 * and that can legitimately run for minutes on a slow network. A keypress that
 * declared such a lock stale would switch credentials underneath a tick that is
 * itself mid-switch, which is the precise failure the lock exists to prevent.
 *
 * So the pid check is the only thing allowed to break a lock here. A living
 * holder is waited for — which in this UI means "refused, try again", because
 * the operator is standing there and a frozen pane is not an answer.
 */
const LOCK_STALE_SECONDS = Number.MAX_SAFE_INTEGER;

function outcome(
  ctx: ActionContext,
  action: PendingAction,
  ok: boolean,
  lines: string[],
): ActionOutcome {
  return {
    ok,
    title: action.label,
    lines,
    at: (ctx.now?.() ?? new Date()).toISOString(),
    dryRun: ctx.dryRun,
  };
}

/**
 * Run one action and report what happened.
 *
 * Never throws: a dashboard that dies because a switch failed has taken away
 * the one screen that could have explained the failure.
 */
export async function runAction(ctx: ActionContext, action: PendingAction): Promise<ActionOutcome> {
  // The lock acquisition and the release are INSIDE the guard, not around it.
  // Both touch the filesystem and both can throw — a read-only or full state
  // directory, an EACCES on the lock — and a throw escaping this function is
  // not a visible failure: the caller's `busy` flag never clears, so every
  // subsequent key is refused with "an action is still running" for the rest of
  // the session, with nothing drawn to say why.
  let locked = false;
  try {
    locked = ctx.store.acquireLock('tick', LOCK_STALE_SECONDS);
    if (!locked) {
      return outcome(ctx, action, false, [
        'another rotorcc operation holds the lock, so nothing was done.',
        'The watcher ticks every minute and holds it while it acts; try again in a moment.',
      ]);
    }
    return await perform(ctx, action);
  } catch (err) {
    return outcome(ctx, action, false, [
      `the action failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 400),
    ]);
  } finally {
    if (locked) {
      try {
        ctx.store.releaseLock('tick');
      } catch {
        /* `releaseLock` already swallows the ordinary cases; this is the rest */
      }
    }
  }
}

async function perform(ctx: ActionContext, action: PendingAction): Promise<ActionOutcome> {
  const lines: string[] = [];
  const out = (line: string): void => {
    lines.push(line);
  };
  const accountsCtx = {
    config: ctx.config,
    manager: ctx.manager,
    dryRun: ctx.dryRun,
    json: false,
    // `yes` is set because the confirmation already happened, in the pane, with
    // the account's spend on both windows in front of the operator. Passing
    // `false` here would make a command that has been confirmed print
    // "re-run with --yes" and do nothing, which reads as a silent failure.
    yes: true,
    out,
  };

  switch (action.kind) {
    case 'switch': {
      // `rotorcc switch <slot>`, exactly.
      const code = await switchCommand(accountsCtx, { identifier: String(action.slot ?? '') });
      ctx.logger.info('tui: switch', { slot: action.slot ?? null, code });
      return outcome(ctx, action, code === 0, lines);
    }

    case 'rotate-best': {
      // `rotorcc switch --strategy <s> --force`: no identifier, so the selector
      // chooses, and `force` re-polls first so the choice is made on numbers
      // read now rather than on whatever the poll floor last allowed.
      const code = await switchCommand(accountsCtx, {
        strategy: action.strategy ?? ctx.config.strategy,
        force: true,
      });
      ctx.logger.info('tui: rotate to best', { strategy: action.strategy ?? null, code });
      return outcome(ctx, action, code === 0, lines);
    }

    case 'set-disabled': {
      // `rotorcc accounts disable|enable <slot>`, exactly.
      const code = setDisabled(accountsCtx, String(action.slot ?? ''), action.disabled === true);
      ctx.logger.info('tui: set disabled', {
        slot: action.slot ?? null,
        disabled: action.disabled === true,
        code,
      });
      return outcome(ctx, action, code === 0, lines);
    }

    case 'set-strategy': {
      // `rotorcc config set strategy <value>`, exactly — including the
      // re-validation, which is the part that stops a typo becoming a config
      // the next start refuses to load.
      const strategy = action.strategy;
      if (strategy === undefined) return outcome(ctx, action, false, ['no strategy was chosen']);
      if (ctx.dryRun) {
        return outcome(ctx, action, true, [
          `DRY RUN — would set strategy to "${strategy}". The config was not written.`,
        ]);
      }
      const path = configPathFor(ctx.configPath);
      const next = setConfigValue(loadConfig(ctx.configPath), 'strategy', strategy);
      saveConfig(next, path);
      ctx.logger.info('tui: strategy changed', { strategy });
      return outcome(ctx, action, true, [
        `strategy = "${strategy}"`,
        `written to ${path}`,
        'The watcher picks this up on its next tick; nothing was switched.',
      ]);
    }

    case 'checkpoint': {
      // The same call `rotorcc push-unpushed` makes. `skipSnapshot` is not set,
      // so transcripts are copied too: an operator reaching for this is asking
      // for everything to be safe, not for half of it.
      const result = await performCheckpoint({
        config: ctx.config,
        store: ctx.store,
        logger: ctx.logger,
        trigger: 'tui:checkpoint',
        dryRun: ctx.dryRun,
      });
      let failed = 0;
      let skipped = 0;
      let saved = 0;
      let pushed = 0;
      const detail: string[] = [];
      for (const project of result.projects) {
        for (const item of project.outcomes) {
          if (item.error !== null) failed += 1;
          else if (item.skipped !== null) skipped += 1;
          else if (item.committed) saved += 1;
          if (item.pushed) pushed += 1;
          const state =
            item.error !== null
              ? `ERROR ${item.error}`
              : item.skipped !== null
                ? `skipped: ${item.skipped}`
                : `${item.committed ? 'checkpointed' : 'clean'}${item.pushed ? ' + pushed' : ''}`;
          detail.push(`${item.branch.padEnd(40)} ${state}`);
        }
      }
      // The summary goes FIRST, because the pane shows the first few lines and
      // an operator who cannot see that two trees were skipped will rotate
      // believing everything was saved. A skip is not an error — a protected
      // branch is a legitimate refusal — but it is exactly the thing that has
      // to survive being summarised.
      out(
        `${saved} checkpointed · ${pushed} pushed · ${skipped} SKIPPED · ${failed} failed` +
          (skipped > 0 ? '  — the skipped ones hold work rotorcc did not save' : ''),
      );
      const snapshot = result.snapshot;
      if (snapshot !== null) {
        out(`snapshot: ${snapshot.filesCopied} file(s), ${snapshot.bytesCopied} new byte(s)`);
      }
      for (const line of detail) out(line);
      if (detail.length === 0) out('no watched tree had anything to save');
      return outcome(ctx, action, failed === 0, lines);
    }

    case 'clear-flags': {
      // The same two flags `rotorcc resume --clear` clears, and only those.
      // ALL_ACCOUNTS_EXHAUSTED is a fact about quota rather than an instruction
      // to a session, and clearing it by hand would only hide it until the next
      // tick raised it again.
      if (ctx.dryRun) {
        return outcome(ctx, action, true, ['DRY RUN — no flag was cleared.']);
      }
      const rotate = ctx.store.clearFlag(FLAG_ROTATE_NOW);
      const soft = ctx.store.clearFlag(FLAG_SOFT_CHECKPOINT);
      ctx.logger.info('tui: flags cleared', { rotate, soft });
      out(rotate ? 'cleared ROTATE_NOW' : 'ROTATE_NOW was not raised');
      out(soft ? 'cleared SOFT_CHECKPOINT_REQUESTED' : 'SOFT_CHECKPOINT_REQUESTED was not raised');
      out('ALL_ACCOUNTS_EXHAUSTED is left alone: it describes quota, not an instruction.');
      return outcome(ctx, action, true, lines);
    }
  }
}
