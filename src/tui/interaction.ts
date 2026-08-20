/**
 * The dashboard's keyboard, as a pure reducer.
 *
 * `handleKey(key, state, context) -> { state, intent }`. No terminal, no
 * filesystem, no clock. Every branch is reachable from a test, which is the
 * only way a control surface that can switch accounts and move quota stays
 * trustworthy: the interesting failures here are "the confirm was skipped" and
 * "two actions ran at once", and neither is something to discover by hand in a
 * terminal.
 *
 * Three rules shape the whole file.
 *
 *   1. **One action at a time.** While an action is in flight every key that
 *      would start another is refused with a note rather than queued. A
 *      dashboard that fires a second switch while the first is mid-rollback is
 *      worse than one that does nothing.
 *
 *   2. **Anything that changes the machine is confirmed.** Switching accounts
 *      moves where quota is spent, and quota is money. The confirmation names
 *      the account, the current spend on BOTH windows, and what will happen —
 *      never a bare "are you sure?".
 *
 *   3. **`q` never quits out from under a decision.** Inside a confirmation it
 *      cancels. Losing a dashboard is cheap; answering "yes" to the wrong
 *      question because the key meant something else in this context is not.
 */
import type { Strategy } from '../accounts/select.js';

export const STRATEGY_CHOICES: Strategy[] = [
  'work-aware',
  'best',
  'next-available',
  'consume-first',
];

/** What an action did, as the TUI shows it back. */
export interface ActionOutcome {
  ok: boolean;
  /** The action, in the operator's words. */
  title: string;
  /** The command's own output, captured verbatim. */
  lines: string[];
  at: string;
  /** True when this ran under --dry-run and therefore changed nothing. */
  dryRun: boolean;
}

export type ActionKind =
  'switch' | 'rotate-best' | 'set-disabled' | 'set-strategy' | 'checkpoint' | 'clear-flags';

/** An action that has been chosen but not yet run. */
export interface PendingAction {
  kind: ActionKind;
  /** The slot this targets, for the account actions. */
  slot?: number;
  disabled?: boolean;
  strategy?: Strategy;
  /** What the operator asked for, in words, for the header and the outcome. */
  label: string;
}

export type Overlay =
  | { kind: 'none' }
  | { kind: 'help' }
  | { kind: 'why' }
  | { kind: 'strategy'; index: number }
  | { kind: 'confirm'; action: PendingAction; prompt: string[] }
  | { kind: 'outcome'; outcome: ActionOutcome };

export interface UiState {
  /** Index into the account list. Clamped by every reducer that moves it. */
  cursor: number;
  overlay: Overlay;
  paused: boolean;
  /** The label of the action in flight, or null. Single-flight, always. */
  busy: string | null;
  /** The last action's result, kept under the accounts until the next one. */
  lastOutcome: ActionOutcome | null;
  /** A one-line transient note: a refusal to start a second action, mostly. */
  note: string | null;
}

export function initialUiState(): UiState {
  return {
    cursor: 0,
    overlay: { kind: 'none' },
    paused: false,
    busy: null,
    lastOutcome: null,
    note: null,
  };
}

/** The account facts the keyboard needs. Deliberately not the whole reading. */
export interface KeyAccount {
  slot: number;
  label: string;
  disabled: boolean;
  active: boolean;
  /** Both windows, already formatted: `5h 78% used · 7d 90% used`. */
  windows: string;
  /** Which window binds and when it lets go, already formatted. */
  binding: string;
}

export interface KeyContext {
  accounts: KeyAccount[];
  strategy: Strategy;
  dryRun: boolean;
  /** True when at least one flag is raised, so `clear flags` is offered. */
  flagsRaised: boolean;
}

export type Intent =
  | { kind: 'none' }
  | { kind: 'quit' }
  /** Re-read the machine. `force` bypasses the per-account poll floor. */
  | { kind: 'gather'; force: boolean }
  | { kind: 'run'; action: PendingAction };

const NOTHING: Intent = { kind: 'none' };

// Written as escapes rather than literal control bytes: a raw ESC in source
// survives an editor, a diff and a copy-paste only by luck, and a key map that
// silently stops matching is invisible until somebody presses the key.
const UP_KEYS = new Set(['k', '\u001b[A', '\u001bOA']);
const DOWN_KEYS = new Set(['j', '\u001b[B', '\u001bOB']);
const ENTER = new Set(['\r', '\n']);
const CTRL_C = '\u0003';
const CTRL_D = '\u0004';

function clampCursor(index: number, count: number): number {
  if (count === 0) return 0;
  return Math.max(0, Math.min(count - 1, index));
}

function selected(state: UiState, context: KeyContext): KeyAccount | null {
  return context.accounts[clampCursor(state.cursor, context.accounts.length)] ?? null;
}

/**
 * The confirmation for a switch.
 *
 * Names BOTH windows for the target, because "switch to slot 3" is not a
 * decision anybody can make from a slot number: an account whose 5-hour window
 * is spent and whose week is healthy, and one whose week is gone, look
 * identical until the numbers are on the screen next to the question.
 */
function switchPrompt(target: KeyAccount, dryRun: boolean): string[] {
  return [
    `Switch the live credential to slot ${target.slot} (${target.label})?`,
    '',
    `  spend now   ${target.windows}`,
    `  binding     ${target.binding}`,
    '',
    'Claude Code re-reads its credential per request, so a session running right',
    'now moves to this account on its next turn. Work already in flight is not',
    'interrupted and nothing is checkpointed by this.',
    ...(dryRun ? ['', 'This rotorcc is in DRY RUN: nothing will actually be written.'] : []),
  ];
}

function rotatePrompt(context: KeyContext): string[] {
  return [
    `Rotate to the best target now, using the "${context.strategy}" strategy?`,
    '',
    'rotorcc re-polls every account first, ignoring the poll floor, then picks',
    'and switches. It refuses rather than guessing when nothing qualifies — an',
    'account it could not measure is never a target.',
    ...(context.dryRun ? ['', 'DRY RUN: nothing will actually be written.'] : []),
  ];
}

function disablePrompt(target: KeyAccount): string[] {
  return [
    `Hold slot ${target.slot} (${target.label}) out of automatic rotation?`,
    '',
    `  spend now   ${target.windows}`,
    '',
    'It stays switchable by name. Disabling the last healthy account is how a',
    'machine ends up with nowhere to rotate to, so rotorcc asks first.',
  ];
}

function checkpointPrompt(): string[] {
  return [
    'Commit and push every watched worktree now?',
    '',
    'This is the same checkpoint the watcher performs: a commit object written',
    'through a temporary index, recorded at refs/rotorcc/checkpoints/<branch>,',
    'and your own commits pushed only when the remote tip is provably an',
    'ancestor. Your index, files and branch are not touched.',
  ];
}

function clearFlagsPrompt(): string[] {
  return [
    'Clear the raised flags?',
    '',
    'ROTATE_NOW and SOFT_CHECKPOINT_REQUESTED are instructions to a live',
    'session. Clearing them is right when the condition that raised them has',
    'passed, and wrong while it still holds — the session will simply stop',
    'being told to wrap up.',
    '',
    'ALL_ACCOUNTS_EXHAUSTED is NOT cleared here. It is a fact about quota',
    'rather than an instruction, and it clears itself when a window resets.',
  ];
}

/**
 * One key press.
 *
 * Returns the next state and at most one intent. The caller performs the
 * intent; nothing in this file touches the world.
 *
 * The single-flight rule is enforced HERE rather than at each key, and that is
 * the whole reason this wrapper exists. It used to be one check placed among
 * the action keys, which the overlays walked straight past: with a switch in
 * flight, `w` opened the why panel, `c` opened a checkpoint confirmation and
 * `y` launched it, because the overlay branches sit above that check. Nothing
 * was corrupted — the tick lock caught it — but the operator got a failure
 * report for an action they had confirmed, and `busy` was cleared by the second
 * action's outcome while the first was still running.
 *
 * A rule with one exception is a rule with none. Any key that would start an
 * action while one is running is refused, whatever path it arrived by.
 */
export function handleKey(
  key: string,
  state: UiState,
  context: KeyContext,
): { state: UiState; intent: Intent } {
  const result = route(key, state, context);
  if (result.intent.kind === 'run' && state.busy !== null) {
    return {
      state: {
        ...state,
        overlay: { kind: 'none' },
        note: `"${state.busy}" is still running — one action at a time`,
      },
      intent: NOTHING,
    };
  }
  return result;
}

function route(
  key: string,
  state: UiState,
  context: KeyContext,
): { state: UiState; intent: Intent } {
  const count = context.accounts.length;
  const cursor = clampCursor(state.cursor, count);
  const base: UiState = { ...state, cursor, note: null };

  // ------------------------------------------------------------ overlays
  switch (base.overlay.kind) {
    case 'confirm': {
      const { action } = base.overlay;
      if (key === 'y' || key === 'Y' || ENTER.has(key)) {
        return {
          state: { ...base, overlay: { kind: 'none' }, busy: action.label },
          intent: { kind: 'run', action },
        };
      }
      // `q` cancels here rather than quitting. A key that means "leave" in one
      // context and "answer the question in front of you" in another is how a
      // confirmation gets defeated by muscle memory.
      return {
        state: { ...base, overlay: { kind: 'none' }, note: `cancelled: ${action.label}` },
        intent: NOTHING,
      };
    }

    case 'strategy': {
      const index = base.overlay.index;
      if (UP_KEYS.has(key)) {
        return {
          state: {
            ...base,
            overlay: { kind: 'strategy', index: Math.max(0, index - 1) },
          },
          intent: NOTHING,
        };
      }
      if (DOWN_KEYS.has(key)) {
        return {
          state: {
            ...base,
            overlay: { kind: 'strategy', index: Math.min(STRATEGY_CHOICES.length - 1, index + 1) },
          },
          intent: NOTHING,
        };
      }
      if (ENTER.has(key)) {
        const strategy = STRATEGY_CHOICES[index] ?? context.strategy;
        const action: PendingAction = {
          kind: 'set-strategy',
          strategy,
          label: `set strategy to "${strategy}"`,
        };
        return {
          state: { ...base, overlay: { kind: 'none' }, busy: action.label },
          intent: { kind: 'run', action },
        };
      }
      return { state: { ...base, overlay: { kind: 'none' } }, intent: NOTHING };
    }

    case 'why': {
      // The panel that answers "why did nothing happen?" also carries the two
      // things an operator can do about it, because an explanation you have to
      // leave the pane to act on is only half an answer.
      if (key === 'c') {
        return {
          state: {
            ...base,
            overlay: {
              kind: 'confirm',
              action: { kind: 'checkpoint', label: 'checkpoint every watched tree' },
              prompt: checkpointPrompt(),
            },
          },
          intent: NOTHING,
        };
      }
      if (key === 'x') {
        if (!context.flagsRaised) {
          return { state: { ...base, note: 'no flag is raised' }, intent: NOTHING };
        }
        return {
          state: {
            ...base,
            overlay: {
              kind: 'confirm',
              action: { kind: 'clear-flags', label: 'clear the raised flags' },
              prompt: clearFlagsPrompt(),
            },
          },
          intent: NOTHING,
        };
      }
      if (key === 'f') {
        return {
          state: { ...base, overlay: { kind: 'none' } },
          intent: { kind: 'gather', force: true },
        };
      }
      if (key === 'q' || key === CTRL_C || key === CTRL_D)
        return { state: base, intent: { kind: 'quit' } };
      return { state: { ...base, overlay: { kind: 'none' } }, intent: NOTHING };
    }

    case 'help':
    case 'outcome': {
      if (key === 'q' || key === CTRL_C || key === CTRL_D) {
        return { state: base, intent: { kind: 'quit' } };
      }
      return { state: { ...base, overlay: { kind: 'none' } }, intent: NOTHING };
    }

    case 'none':
      break;
  }

  // --------------------------------------------------------------- global
  if (key === CTRL_C || key === CTRL_D || key === 'q') {
    return { state: base, intent: { kind: 'quit' } };
  }
  if (key === '?') return { state: { ...base, overlay: { kind: 'help' } }, intent: NOTHING };
  if (key === 'w') return { state: { ...base, overlay: { kind: 'why' } }, intent: NOTHING };
  if (key === 'o') {
    // The last action's FULL output. The pane shows the first few lines under
    // the accounts, which is right for a glance and wrong for the case that
    // matters: a checkpoint that skipped two trees is a success whose detail
    // decides whether it is safe to rotate.
    if (base.lastOutcome === null) {
      return { state: { ...base, note: 'no action has run yet' }, intent: NOTHING };
    }
    return {
      state: { ...base, overlay: { kind: 'outcome', outcome: base.lastOutcome } },
      intent: NOTHING,
    };
  }
  if (key === 'p') return { state: { ...base, paused: !base.paused }, intent: NOTHING };
  if (UP_KEYS.has(key)) {
    return { state: { ...base, cursor: clampCursor(cursor - 1, count) }, intent: NOTHING };
  }
  if (DOWN_KEYS.has(key)) {
    return { state: { ...base, cursor: clampCursor(cursor + 1, count) }, intent: NOTHING };
  }
  if (key === 'r') return { state: base, intent: { kind: 'gather', force: false } };
  if (key === 'f') return { state: base, intent: { kind: 'gather', force: true } };

  // ------------------------------------------------------------- actions
  // Everything below changes the machine. One at a time, without exception:
  // a second switch started while the first is between "credential written"
  // and "roster updated" is how a slot ends up holding another slot's login.
  if (base.busy !== null) {
    return {
      state: { ...base, note: `"${base.busy}" is still running — one action at a time` },
      intent: NOTHING,
    };
  }

  if (key === 't') {
    const index = Math.max(0, STRATEGY_CHOICES.indexOf(context.strategy));
    return { state: { ...base, overlay: { kind: 'strategy', index } }, intent: NOTHING };
  }

  if (key === 'b') {
    return {
      state: {
        ...base,
        overlay: {
          kind: 'confirm',
          action: {
            kind: 'rotate-best',
            strategy: context.strategy,
            label: `rotate to the best target (${context.strategy})`,
          },
          prompt: rotatePrompt(context),
        },
      },
      intent: NOTHING,
    };
  }

  const target = selected(base, context);
  if (target === null) {
    if (key === 's' || key === 'd' || ENTER.has(key)) {
      return { state: { ...base, note: 'there is no account to act on' }, intent: NOTHING };
    }
    return { state: base, intent: NOTHING };
  }

  if (key === 's' || ENTER.has(key)) {
    if (target.active) {
      return {
        state: { ...base, note: `slot ${target.slot} is already the live account` },
        intent: NOTHING,
      };
    }
    return {
      state: {
        ...base,
        overlay: {
          kind: 'confirm',
          action: {
            kind: 'switch',
            slot: target.slot,
            label: `switch to slot ${target.slot} (${target.label})`,
          },
          prompt: switchPrompt(target, context.dryRun),
        },
      },
      intent: NOTHING,
    };
  }

  if (key === 'd') {
    if (target.disabled) {
      // Putting an account BACK into rotation adds an option; it cannot strand
      // the machine, so it runs without a confirmation.
      const action: PendingAction = {
        kind: 'set-disabled',
        slot: target.slot,
        disabled: false,
        label: `enable slot ${target.slot} (${target.label})`,
      };
      return { state: { ...base, busy: action.label }, intent: { kind: 'run', action } };
    }
    return {
      state: {
        ...base,
        overlay: {
          kind: 'confirm',
          action: {
            kind: 'set-disabled',
            slot: target.slot,
            disabled: true,
            label: `disable slot ${target.slot} (${target.label})`,
          },
          prompt: disablePrompt(target),
        },
      },
      intent: NOTHING,
    };
  }

  return { state: base, intent: NOTHING };
}

/** Fold an action's result back in: it stops being busy and is shown, not hidden. */
export function applyOutcome(state: UiState, outcome: ActionOutcome): UiState {
  return {
    ...state,
    busy: null,
    lastOutcome: outcome,
    note: null,
    // Failures take over the screen; successes sit under the accounts. An
    // action whose result you have to go and look for is only half-built, and
    // one that failed silently is the defect this project keeps removing.
    overlay: outcome.ok ? state.overlay : { kind: 'outcome', outcome },
  };
}
