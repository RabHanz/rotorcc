/**
 * The dashboard's keyboard.
 *
 * A pane that can switch accounts is a control surface, and the failures that
 * matter in a control surface are not visual. They are: the confirmation was
 * skipped, two actions ran at once, a key meant one thing in one context and
 * something destructive in another. Each of those is one line of code away at
 * all times and none of them is discoverable by looking at a terminal.
 *
 * So the keyboard is a pure reducer and this file is the contract it keeps.
 */
import { describe, expect, it } from 'vitest';

import {
  type KeyAccount,
  type KeyContext,
  type UiState,
  STRATEGY_CHOICES,
  applyOutcome,
  handleKey,
  initialUiState,
} from '../src/tui/interaction.js';
import {
  type GatherRequest,
  coalescingRunner,
  mergeGatherRequests,
  normaliseKey,
} from '../src/tui/app.js';

const UP = '\u001b[A';
const DOWN = '\u001b[B';
const ENTER = '\r';

function account(overrides: Partial<KeyAccount> = {}): KeyAccount {
  return {
    slot: 1,
    label: 'primary',
    disabled: false,
    active: false,
    windows: '5h 99% used · 7d 72% used',
    binding: '5h binds · resets 2026-08-20 04:00',
    ...overrides,
  };
}

function context(overrides: Partial<KeyContext> = {}): KeyContext {
  return {
    accounts: [
      account({ slot: 1, label: 'primary', active: true }),
      account({ slot: 2, label: 'backup' }),
      account({ slot: 3, label: 'spare', disabled: true }),
    ],
    strategy: 'work-aware',
    dryRun: false,
    flagsRaised: false,
    ...overrides,
  };
}

/** Feed a sequence of keys and return the final state plus every intent seen. */
function press(keys: string[], ctx = context(), start: UiState = initialUiState()) {
  let state = start;
  const intents = [];
  for (const key of keys) {
    const result = handleKey(key, state, ctx);
    state = result.state;
    intents.push(result.intent);
  }
  return { state, intents };
}

describe('moving around', () => {
  it('moves the cursor with the arrows and with j/k', () => {
    expect(press([DOWN]).state.cursor).toBe(1);
    expect(press([DOWN, DOWN]).state.cursor).toBe(2);
    expect(press(['j', 'j', 'k']).state.cursor).toBe(1);
  });

  it('clamps at both ends rather than wrapping onto the wrong account', () => {
    // Wrapping is a nice touch on a menu. On a list where enter switches the
    // live credential, "one past the end" landing back on the first account is
    // a way to switch to something you were not looking at.
    expect(press([UP, UP, UP]).state.cursor).toBe(0);
    expect(press([DOWN, DOWN, DOWN, DOWN, DOWN]).state.cursor).toBe(2);
  });

  it('survives an empty account list', () => {
    const empty = context({ accounts: [] });
    const { state, intents } = press([DOWN, ENTER], empty);
    expect(state.cursor).toBe(0);
    expect(intents.every((i) => i.kind !== 'run')).toBe(true);
    expect(state.note).toContain('no account');
  });
});

describe('switching', () => {
  it('asks before switching, and names both windows in the question', () => {
    const { state, intents } = press([DOWN, ENTER]);
    // Nothing ran.
    expect(intents.every((i) => i.kind !== 'run')).toBe(true);
    expect(state.overlay.kind).toBe('confirm');
    if (state.overlay.kind !== 'confirm') return;
    expect(state.overlay.action).toMatchObject({ kind: 'switch', slot: 2 });
    const prompt = state.overlay.prompt.join('\n');
    // A slot number is not something anybody can make a decision from.
    expect(prompt).toContain('5h 99% used');
    expect(prompt).toContain('7d 72% used');
  });

  it('runs it on y, and on enter', () => {
    for (const confirm of ['y', ENTER]) {
      const { state, intents } = press([DOWN, 's', confirm]);
      expect(intents[2]).toMatchObject({ kind: 'run', action: { kind: 'switch', slot: 2 } });
      expect(state.busy).toContain('switch to slot 2');
    }
  });

  it('cancels on anything else — including q, which must not quit here', () => {
    for (const key of ['n', '\u001b', 'q', 'x']) {
      const { state, intents } = press([DOWN, 's', key]);
      expect(intents[2]?.kind, `key ${JSON.stringify(key)}`).toBe('none');
      expect(state.overlay.kind).toBe('none');
      expect(state.note).toContain('cancelled');
    }
  });

  it('refuses to switch to the account that is already live', () => {
    const { state, intents } = press(['s']);
    expect(intents[0]?.kind).toBe('none');
    expect(state.note).toContain('already the live account');
  });

  it('says a dry run will change nothing, in the confirmation itself', () => {
    const { state } = press([DOWN, 's'], context({ dryRun: true }));
    expect(state.overlay.kind === 'confirm' && state.overlay.prompt.join('\n')).toContain(
      'DRY RUN',
    );
  });
});

describe('rotating to the best target', () => {
  it('asks first and names the strategy that will choose', () => {
    const { state } = press(['b']);
    expect(state.overlay.kind).toBe('confirm');
    if (state.overlay.kind !== 'confirm') return;
    expect(state.overlay.action.kind).toBe('rotate-best');
    expect(state.overlay.prompt.join('\n')).toContain('work-aware');
  });

  it('carries the strategy in force into the action', () => {
    const { intents } = press(['b', 'y'], context({ strategy: 'consume-first' }));
    expect(intents[1]).toMatchObject({
      kind: 'run',
      action: { kind: 'rotate-best', strategy: 'consume-first' },
    });
  });
});

describe('disabling and enabling', () => {
  it('asks before removing an account from rotation', () => {
    const { state, intents } = press([DOWN, 'd']);
    expect(intents[1]?.kind).toBe('none');
    expect(state.overlay.kind).toBe('confirm');
    if (state.overlay.kind !== 'confirm') return;
    expect(state.overlay.action).toMatchObject({ kind: 'set-disabled', slot: 2, disabled: true });
    // Disabling the last healthy account is how a machine ends up with nowhere
    // to rotate to, so the question names what it is about to hold back.
    expect(state.overlay.prompt.join('\n')).toContain('5h 99% used');
  });

  it('puts one back without asking, because that can only add an option', () => {
    const { intents, state } = press([DOWN, DOWN, 'd']);
    expect(intents[2]).toMatchObject({
      kind: 'run',
      action: { kind: 'set-disabled', slot: 3, disabled: false },
    });
    expect(state.busy).toContain('enable slot 3');
  });
});

describe('the strategy picker', () => {
  it('opens on the strategy in force', () => {
    const { state } = press(['t'], context({ strategy: 'consume-first' }));
    expect(state.overlay).toEqual({
      kind: 'strategy',
      index: STRATEGY_CHOICES.indexOf('consume-first'),
    });
  });

  it('moves and applies', () => {
    const { state, intents } = press(['t', DOWN, ENTER]);
    expect(intents[2]).toMatchObject({
      kind: 'run',
      action: { kind: 'set-strategy', strategy: STRATEGY_CHOICES[1] },
    });
    expect(state.overlay.kind).toBe('none');
  });

  it('clamps at the ends of the list', () => {
    const { state } = press(['t', UP, UP, UP, UP]);
    expect(state.overlay).toEqual({ kind: 'strategy', index: 0 });
    const bottom = press(['t', DOWN, DOWN, DOWN, DOWN, DOWN, DOWN]);
    expect(bottom.state.overlay).toEqual({
      kind: 'strategy',
      index: STRATEGY_CHOICES.length - 1,
    });
  });
});

describe('the why panel', () => {
  it('offers a checkpoint, and confirms it before running', () => {
    const { state, intents } = press(['w', 'c']);
    expect(intents[1]?.kind).toBe('none');
    expect(state.overlay.kind).toBe('confirm');
    if (state.overlay.kind !== 'confirm') return;
    expect(state.overlay.action.kind).toBe('checkpoint');
  });

  it('offers to clear flags only when a flag is actually raised', () => {
    const quiet = press(['w', 'x']);
    expect(quiet.state.overlay.kind).toBe('why');
    expect(quiet.state.note).toContain('no flag is raised');

    const raised = press(['w', 'x'], context({ flagsRaised: true }));
    expect(raised.state.overlay.kind).toBe('confirm');
    if (raised.state.overlay.kind !== 'confirm') return;
    expect(raised.state.overlay.action.kind).toBe('clear-flags');
    // Clearing an instruction while the condition still holds is a real
    // mistake, so the question says so rather than just asking.
    expect(raised.state.overlay.prompt.join('\n')).toContain('wrong while it still holds');
  });

  it('re-polls from inside the panel, ignoring the poll floor', () => {
    const { intents } = press(['w', 'f']);
    expect(intents[1]).toEqual({ kind: 'gather', force: true });
  });
});

describe('refreshing', () => {
  it('separates "read again" from "spend a quota request"', () => {
    // `r` on a held-down key must not turn an idle operator into their own
    // rate-limit incident.
    expect(press(['r']).intents[0]).toEqual({ kind: 'gather', force: false });
    expect(press(['f']).intents[0]).toEqual({ kind: 'gather', force: true });
  });
});

describe('one action at a time', () => {
  const busy: UiState = { ...initialUiState(), busy: 'switch to slot 2 (backup)' };

  it('refuses to start a second action and says which one is running', () => {
    for (const key of ['s', 'd', 'b', 't', ENTER]) {
      const result = handleKey(key, busy, context());
      expect(result.intent.kind, `key ${JSON.stringify(key)}`).toBe('none');
      expect(result.state.note).toContain('one action at a time');
    }
  });

  it('still lets you look around and leave while one is running', () => {
    expect(handleKey(DOWN, busy, context()).state.cursor).toBe(1);
    expect(handleKey('w', busy, context()).state.overlay.kind).toBe('why');
    expect(handleKey('q', busy, context()).intent.kind).toBe('quit');
  });

  it('cannot be walked around through an overlay', () => {
    // The hole this closes: the overlay branches sit above the per-key busy
    // check, so with a switch in flight `w` opened the why panel, `c` opened a
    // checkpoint confirmation, and `y` launched a second action. Nothing was
    // corrupted — the tick lock caught it — but the operator got a failure
    // report for an action they had confirmed, and the second outcome cleared
    // `busy` while the first was still running.
    const viaWhy = press(['w', 'c', 'y'], context(), busy);
    expect(viaWhy.intents.every((i) => i.kind !== 'run')).toBe(true);
    expect(viaWhy.state.note).toContain('one action at a time');
    expect(viaWhy.state.overlay.kind).toBe('none');

    const viaFlags = press(['w', 'x', 'y'], context({ flagsRaised: true }), busy);
    expect(viaFlags.intents.every((i) => i.kind !== 'run')).toBe(true);

    // And a confirmation that was already open when the action started cannot
    // be answered into a second run either.
    const stale: UiState = {
      ...busy,
      overlay: {
        kind: 'confirm',
        action: { kind: 'checkpoint', label: 'checkpoint' },
        prompt: ['?'],
      },
    };
    expect(handleKey('y', stale, context()).intent.kind).toBe('none');
    expect(handleKey(ENTER, stale, context()).intent.kind).toBe('none');
  });
});

describe('seeing the last result again', () => {
  const done = {
    ok: true,
    title: 'checkpoint every watched tree',
    lines: ['3 checkpointed · 1 pushed · 2 SKIPPED · 0 failed', 'a', 'b', 'c', 'd', 'e'],
    at: '2026-08-20T01:00:00Z',
    dryRun: false,
  };

  it('opens the full output on o, because the pane only shows the first few lines', () => {
    // A checkpoint that skipped two trees is a SUCCESS whose detail decides
    // whether it is safe to rotate. Without this the detail was unreachable.
    const state = handleKey('o', { ...initialUiState(), lastOutcome: done }, context()).state;
    expect(state.overlay).toEqual({ kind: 'outcome', outcome: done });
  });

  it('says so plainly when nothing has run yet', () => {
    const state = handleKey('o', initialUiState(), context()).state;
    expect(state.overlay.kind).toBe('none');
    expect(state.note).toContain('no action has run yet');
  });
});

describe('what counts as one key press', () => {
  it('accepts a single character and the arrow sequences', () => {
    expect(normaliseKey('s')).toBe('s');
    expect(normaliseKey(UP)).toBe(UP);
    expect(normaliseKey(DOWN)).toBe(DOWN);
  });

  it('ignores anything longer, so a paste cannot fire a run of actions', () => {
    // A paste into a pane where `d` disables an account and enter confirms is
    // not an input method, it is an accident waiting to happen.
    expect(normaliseKey('ddddd')).toBeNull();
    expect(normaliseKey('sy')).toBeNull();
    expect(normaliseKey('some pasted text\r')).toBeNull();
  });
});

describe('refresh requests that arrive mid-flight', () => {
  it('runs exactly once more afterwards, rather than being dropped', async () => {
    // The refresh after an action must not be discarded because the periodic
    // one started a few hundred milliseconds earlier: that run's reading was
    // taken BEFORE the credential moved, so the pane would report a successful
    // switch above an account table still marking the old account active.
    const seen: GatherRequest[] = [];
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let first = true;
    const run = coalescingRunner<GatherRequest>(async (request) => {
      seen.push(request);
      if (first) {
        first = false;
        await gate;
      }
    }, mergeGatherRequests);

    const inFlight = run({});
    // Three requests while the first is running collapse into one follow-up.
    void run({ force: false });
    void run({ force: true });
    void run({ force: false });
    release();
    await inFlight;

    expect(seen).toHaveLength(2);
    // And the merge keeps the strongest request: one of them asked to re-poll.
    expect(seen[1]).toEqual({ ignorePause: true, force: true });
  });

  it('does nothing extra when nothing arrived while it ran', async () => {
    const seen: GatherRequest[] = [];
    const run = coalescingRunner<GatherRequest>(async (request) => {
      seen.push(request);
    }, mergeGatherRequests);
    await run({ force: true });
    expect(seen).toEqual([{ force: true }]);
  });
});

describe('quitting', () => {
  it('quits on q, Ctrl-C and Ctrl-D', () => {
    for (const key of ['q', '\u0003', '\u0004']) {
      expect(handleKey(key, initialUiState(), context()).intent.kind).toBe('quit');
    }
  });
});

describe('showing the outcome', () => {
  const done = {
    ok: true,
    title: 'switch to slot 2 (backup)',
    lines: ['switched from slot 1 to slot 2'],
    at: '2026-08-20T01:00:00Z',
    dryRun: false,
  };

  it('clears busy and keeps the result on screen', () => {
    const state = applyOutcome({ ...initialUiState(), busy: done.title }, done);
    expect(state.busy).toBeNull();
    expect(state.lastOutcome).toEqual(done);
  });

  it('takes over the screen when the action FAILED', () => {
    // An action that failed silently is the defect this project keeps removing.
    const state = applyOutcome(initialUiState(), { ...done, ok: false });
    expect(state.overlay.kind).toBe('outcome');
  });

  it('does not take over the screen when it worked', () => {
    expect(applyOutcome(initialUiState(), done).overlay.kind).toBe('none');
  });
});
