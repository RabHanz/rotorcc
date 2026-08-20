# ADR 0004 — the dashboard is a control surface, and it drives the CLI

- **Status:** accepted
- **Date:** 2026-08-20
- **Relates to:** [ADR 0001](0001-own-the-account-layer.md) (rotorcc owns its
  account layer), [ADR 0003](0003-live-credential-hot-swap.md) (a live session
  can be moved between accounts)

## The complaint

> "needs interactive controls like cswap and not just be a glorified
> observability!"

Fair. `rotorcc tui` showed headroom, unsaved work and a decision journal, and
then the operator opened a second terminal to do anything about it. A pane you
can only watch does not earn a terminal split — the whole value of a dashboard
during an incident is that the thing you decide is the thing you can then do,
without changing context and without retyping a slot number you just read.

The comparison is deliberate: cswap (MIT, `github.com/realiti4/claude-swap`) has
had this for a while. Its Textual app owns the poll loop and every mutating
action, so its dashboard, its watch view and its menus all reach the same
`ClaudeAccountSwitcher` methods. That structure is right and this ADR adopts it.

## The decision

**Every acting key in the dashboard calls the function the matching CLI verb
calls. There is no second implementation of anything.**

| key         | what it does                          | the code it runs                   |
| ----------- | ------------------------------------- | ---------------------------------- |
| `enter`/`s` | switch to the selected account        | `switchCommand`                    |
| `b`         | rotate to the best target now         | `switchCommand` with no identifier |
| `d`         | disable / enable the selected account | `setDisabled`                      |
| `t`         | change the rotation strategy          | `setConfigValue` + `saveConfig`    |
| `f`         | force a quota re-poll                 | `manager.readUsage({force:true})`  |
| `w` → `c`   | checkpoint everything now             | `performCheckpoint`                |
| `w` → `x`   | clear the raised flags                | `store.clearFlag`                  |
| `o`         | the last action's full output         | — (reads what the action returned) |

`src/tui/actions.ts` is the whole adapter: it collects the command's `out`
lines, turns its exit code into an outcome, and hands that back to the pane.

The reason for the constraint is not tidiness. It is that a TUI with its own
switch has **two switch implementations, and the one nobody tests is the one
that runs at three in the morning** when an account is about to expire. The
account layer is the most dangerous code in this project — a switch that fails
between "credential written" and "roster updated" loses a login — and it has
exactly one carefully ordered implementation with rollback. Copying its steps
into a keypress handler would be the single worst thing this change could do.

The tests enforce it from the outside: `test/tui-actions.test.ts` asserts the
**effect** — the live credential's fingerprint now matches slot 2's stash, the
roster's `activeSlot` moved, the config file on disk re-validates — rather than
asserting that some function was called. A drifting second implementation would
have to reproduce all of that to keep those tests green, at which point it is
not a second implementation any more.

### Three properties the keyboard must have

**One action at a time.** `busy` is set the moment an action starts and every
key that would start another is refused with a note naming the one in flight.
Two switches interleaving is how a slot ends up holding another slot's login.

**Anything that changes the machine confirms first, with the numbers in front
of you.** The switch confirmation names the target's 5h AND 7d spend, because a
slot number is not something anybody can make a decision from.

There is no exception, and there was nearly one. Enabling an account looked
harmless — it can only add a rotation target — so it ran directly. But `d` is a
_toggle_, and which way it goes depends on a tag on the row; the tag was at the
end of the row, where the width guard cut it first. An operator on an
80-column terminal could press `d` meaning "hold this back" and silently
re-enable it. The tag moved into the name column and the exemption went away. A
rule with one exception is a rule with none.

**`q` never quits out from under a decision.** Inside a confirmation it cancels.
A key that means "leave" in one context and "answer the question in front of
you" in another is how a confirmation gets defeated by muscle memory.

**`q` also never quits out from under an ACTION.** `switchAccount` writes the
live credential and then records the roster, and nothing rolls that back on
process death — rollback runs on a thrown error. So a quit while an action is
in flight is deferred until it finishes, with the pane saying so; asking a
second time overrides it, because an operator who really wants out of a long
checkpoint sweep must not be held by a pane.

### The lock

Every mutating action takes rotorcc's own `tick` lock before doing anything. The
watcher runs every sixty seconds and holds that lock while it decides and acts;
without this, an operator pressing `s` at the wrong second would be switching
credentials underneath a tick that is halfway through switching them itself. A
lock we could not take is reported as a refusal — never as an action that
quietly did nothing.

The same change makes `switchCommand` and the daemon's `performSwitch` pass the
credential store's environment down to `switchAccount`, so Claude Code's own
advisory locks resolve against the same home the credentials do. They did not
before; on a normal machine that was the same directory by luck.

### `--once` and pipes stay read-only

A frame going into a cron mail or a pipe has no cursor, no panels and no key
handling. Handing a control surface to something that cannot answer a
confirmation is worse than handing it nothing.

## Why not a TUI framework

cswap uses Textual, and it buys real things: focus management, modals, a widget
tree. rotorcc has no runtime dependency but `zod`, and the reason is written in
ADR 0001 — this tool is installed by somebody mid-crisis, and every dependency
is a way for that install to fail. A dozen keys, five panels and a confirmation
dialog is not enough UI to be worth a framework, and `renderDashboard` staying a
pure function of `(model, ui)` is what makes the honesty rules testable at all.

## Consequences

### Gains

- The operator decides and acts in one place, on numbers they are looking at.
- One implementation of switch, disable, strategy and checkpoint, with one set
  of tests, whichever surface invokes it.
- The keyboard is a pure reducer, so "the confirmation was skipped" and "two
  actions ran at once" are unit tests rather than things to notice in a
  terminal.

### Accepted costs

- The dashboard can now change the machine, which is a larger blast radius than
  a read-only pane. Mitigated by the confirmations, the single-flight rule, the
  tick lock, and read-only frames wherever there is no keyboard.
- Six keys to learn. They are on the footer and behind `?`, and the help text
  names the command each one is equivalent to.

## The rule, again

> A tool that lies about its own state is worse than no tool.

ADR 0001 applied that to measurement, ADR 0002 to action, ADR 0003 to the tool's
beliefs about the world. This one applies it to **the tool's own second
implementation of itself**: two code paths that are supposed to do the same
thing are a lie waiting for the day they disagree, and the day they disagree is
the day somebody is out of quota at three in the morning.
