# ADR 0002 — rotation is a handover, not an interruption

- **Status:** accepted
- **Date:** 2026-08-19
- **Supersedes:** the "checkpoint, switch, launch a successor" rotation model.

## Context

On 2026-08-19 rotorcc opened a second `claude --continue` in a new tmux pane
onto a session that was alive and working. Two operators, one worktree. It fired
twice before anyone noticed.

The immediate causes were found and fixed in `5258e96`: a transcript signature
from six dying **subagents** was read as the operator dying, and `launchSuccessor`
proceeded even though the tick already knew the predecessor was alive. Liveness
is now ground truth and there is an unconditional guard at the moment of launch.

That fix is correct and stays. But it is a guard on a model that was wrong, and
the Director's question exposed the real problem:

> _how does it stop a running working session when there is already work being
> done when an account nears limits?_

**It cannot.** A Claude Code process reads its credential once, when it
launches. There is no mechanism to change the account of a live session. So
rotorcc's entire rotation design — checkpoint the work, switch the credential,
spawn a fresh `claude --continue` pointed at a resume manifest — was
**abandon and replace**. A new pane appearing was not a bug in that model; it
_was_ the model. The bug was only that it fired when it should not have.

Abandon-and-replace has costs that are not obvious until you watch it happen:

- The successor starts cold. Whatever the predecessor had in context is gone,
  and the manifest is a summary, not the thing itself.
- The seam is where work is lost. Everything between the last checkpoint and the
  kill is unrecoverable, and "in-flight reasoning" is unrecoverable by anyone.
- One misread signal produces a duplicate, and a duplicate on a shared worktree
  is corruption rather than a wasted process.

Meanwhile the thing rotorcc was reacting to was usually the wrong window. The
5-hour window drove the decision, because it is the one that hits first — but it
refills several times a day. Burning a second account's **week** to escape a
window that comes back in three hours is a bad trade, and it is one rotorcc was
making automatically.

## Decision

Four rules. They are implemented in `src/core/policy.ts` as a single pure
function returning **one** action, because a caller that has to work out which
of three returned things takes precedence is a caller that will get it wrong.

### 1. The weekly window is the priority signal

Both windows are tracked. They mean different things:

| window  | refills             | what spending it costs    |
| ------- | ------------------- | ------------------------- |
| 5 hours | several times a day | an hour or two of waiting |
| 7 days  | weekly              | the rest of your week     |

So the **weekly** window decides whether to move accounts, and the 5-hour window
never does on its own. Handover fires at or below `weeklyRotatePct` (5% by
default — i.e. 95% utilised). A spent 5-hour window with a healthy week produces
a checkpoint and a wait, not a switch.

Per-model weekly caps fold into the weekly figure rather than being a third
category, because that is what they are: a slice of the same week's budget.

### 2. Switching means changing the account the NEXT session opens on

`src/core/nextSession.ts` holds one fact: which slot the next session should
start on. The watcher and the live hooks **record** it. `SessionStart`
**consumes** it and performs the switch before the session begins.

- Zero interruption. The running session keeps its account until it ends.
- No successor process, so no possibility of a duplicate.
- The switch costs nothing, because it happens in the one moment where changing
  a credential is free.

The intent is consumed exactly once and carries an expiry. Both matter: this
project has already shipped a defect where a stale instruction was obeyed hours
after it stopped being true.

### 3. When every account is spent, STOP

No rotation. No successor. And **no queued intent either** — a handover onto an
account with 4% of its week left just moves the problem to the next session
start.

Instead: checkpoint everything, write the manifest, raise a dedicated
`ALL_ACCOUNTS_EXHAUSTED` flag, and print a full notice to stderr naming every
account, its headroom and its reset time. An account that could not be
**measured** says so rather than being omitted, because "we could not read this"
and "this is empty" mean different things and only one of them means waiting
will help.

`ALL_ACCOUNTS_EXHAUSTED` is deliberately not `ROTATE_NOW`. The instruction is
the opposite one: `ROTATE_NOW` means "wrap up, a replacement is coming"; this
means "there is nowhere to go, stop starting things". Telling an agent to hand
over to a successor that cannot exist is worse than telling it nothing.

### 4. Never spawn a companion

A successor replaces a session whose **process is gone**, verified by liveness,
and nothing else. For a live session near a limit: warn, checkpoint, record the
intent for next time, and let the operator or the natural end of the session
carry it over.

## The hooks are the intelligence layer

The Director asked whether this could be done with "living intelligent hooks".
It can, and it is the better architecture. rotorcc already owns six Claude Code
lifecycle events; using them turns a guessing problem into an observation one.

| event                 | role                                                                                            |
| --------------------- | ----------------------------------------------------------------------------------------------- |
| `SessionStart`        | **where rotation happens.** Apply the pending handover before the session reads its credential. |
| `UserPromptSubmit`    | cheap live check: surface headroom, warn, checkpoint. Never spawns.                             |
| `Stop` / `SessionEnd` | the natural boundary. Checkpoint, and set the account for next time.                            |
| `PreCompact`          | durability point before context is lost.                                                        |

The 60-second watcher stops being the primary mechanism and becomes a **safety
net for genuinely dead sessions**. Designed this way, "how do you stop a working
session" stops being a question, because you never have to.

## Consequences

### Gains

- The duplicate-session failure is structurally unavailable, not merely guarded.
- A rotation costs nothing: no cold start, no lost context, no seam.
- Weekly quota is no longer spent to escape a five-hour window.
- The "everything is spent" case has an honest answer instead of a thrashing one.

### Accepted costs

- **A handover is not immediate.** If a session runs for six more hours, it runs
  those hours on the old account. That is the correct trade — the alternative is
  killing it — but it means the weekly threshold has to fire early enough to be
  useful, which is why `weeklyWarnPct` exists at 20%.
- **The policy paths need their own latch.** Without it a low window means a
  commit and a push every sixty seconds for hours, which is the 2026-08-18
  defect. `RotorState.policyLatch` is separate from the threshold latches
  because they answer different questions.
- **`rotation.enabled: false` had to be taught about the queue.** An intent
  `SessionStart` would act on is still rotorcc changing the account by itself,
  just later. With rotation disabled nothing is queued — but the account a human
  should move to is still named, because refusing to act is not a reason to
  refuse to inform.
- **Nine e2e tests asserted the old model** and were rewritten. The reason is
  recorded in each one, and `setUsage` now drives the two windows independently,
  because "5 hours nearly gone, week fine" and "week nearly gone" are now
  completely different situations.

## The family this belongs to

This is the fourth defect of one kind, and the rule they all violated is the
same:

> **rotorcc must never report confidently while doing nothing, and never act
> confidently on a signal it misread.**

1. A stale `ROTATE_NOW` from a dry run, obeyed hours later.
2. A dry-run manifest presented as a rescue record.
3. One `"usage": null` blinding the reader, so nothing rotated at all.
4. A subagent's limit message read as the operator's, spawning a duplicate.

The first three were about reporting. The fourth was about acting. The policy
above is the structural answer to the fourth, and the "unknown is unknown"
discipline in ADR 0001 is the structural answer to the first three.
