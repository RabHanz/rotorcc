# ADR 0003 — a live session CAN be moved to another account

- **Status:** accepted
- **Date:** 2026-08-19
- **Supersedes:** the central factual claim of
  [ADR 0002](0002-handover-not-interruption.md). ADR 0002's _judgement_ — the
  weekly window decides, an exhausted fleet stops rather than thrashing — stands
  unchanged and is not superseded.

## The claim that turned out to be false

ADR 0002, and the docstring on `launchSuccessor`, both asserted this:

> A Claude Code process reads its credential once, when it launches. There is no
> supported way to make one process pick up another's credentials, so a new
> process is the only rotation there is.

Every structural decision about rotation followed from it. If a live session
cannot change accounts, then rotation must be abandon-and-replace: checkpoint
the work, switch the credential, spawn a successor pointed at a resume manifest,
and accept a cold start and a seam where work is lost. ADR 0002's whole design —
queue the switch for the NEXT session, never interrupt this one — is the least
bad answer to a constraint that was assumed rather than measured.

**Nobody measured it.** It was inferred from reading code and from how the
failure looked. That is the same mistake this project has now made four times in
a different costume: a confident report about something that was never checked.

## The experiment

Run on Linux, 2026-08-19, against Claude Code v2.1.235.

Entirely inside a throwaway `CLAUDE_CONFIG_DIR`, so no live session on the
machine was touched and no account was switched for real. Two accounts were
used, referred to here as **A** and **B**; they are different logins with
different refresh-token fingerprints.

1. Seed `$TMP/home/.credentials.json` with **A**. Start a real interactive
   `claude` in a tmux pane with `CLAUDE_CONFIG_DIR=$TMP/home`.
2. Prompt 1 — `Reply with exactly: MARK-ONE`. → **`MARK-ONE`.** The session
   works, on A.
3. **Overwrite the credential file with a structurally identical blob whose
   access and refresh tokens are invalid.** Nothing else changed; the process
   was not signalled.
4. Prompt 2 — `Reply with exactly: MARK-TWO`. →
   **`Login expired · Please run /login`.**
5. **Restore A's credential.** Prompt 3 — → **`MARK-TWO` and `MARK-THREE`.** The
   session recovered in place, with no restart, no `/login`, and the turn that
   had failed was still answered.
6. **Overwrite the credential file with account B's credential** — a different
   account entirely. Prompt 4 → **`MARK-FOUR`**, then a 400-word Opus generation
   completed normally.

## What that establishes

**A running Claude Code session reads its credential from disk per request, not
once at launch.** Steps 3–4 prove it: the process was untouched, only the file
changed, and the very next request failed. Step 6 proves the useful half: the
new credential does not merely have to be _valid_, it can belong to a
**different account**, and the conversation continues across the change with its
context intact.

Step 5 adds something that matters for safety: the failure mode is a **per-turn
error, not a crash**. The process survives, the conversation survives, and
putting a good credential back fixes it on the next turn. So the blast radius of
a hot-swap that goes wrong is one turn — bad, but recoverable, and nothing like
losing the session.

### The half-swap trap, found in the same run

After the swap to B, `/status` still displayed **A's** email and organisation.
That block is read from `~/.claude.json`'s `oauthAccount`, not from the
credential — so a rotation that writes only `.credentials.json` leaves the
session running on B while telling the operator it is on A.

That is this project's signature defect, and it would have been introduced by
the obvious implementation of hot-swap. rotorcc's existing `switchAccount`
already splices `oauthAccount` in the same locked transaction, so rotorcc does
not have this bug — but any hot-swap path that bypasses `switchAccount` to "just
write the file quickly" would.

## Decision

**Both mechanisms ship. Neither is deprecated.**

`rotation.mode` takes three values, defaulting to `auto`:

| mode        | what happens                                                             |
| ----------- | ------------------------------------------------------------------------ |
| `hotswap`   | swap the credential under the live session; it keeps running             |
| `successor` | the ADR 0002 path: checkpoint, switch, replace a dead session            |
| `auto`      | attempt hotswap, **verify it took**, fall back to successor if it did not |

The reason for keeping both is not caution for its own sake. **Hot-swap is an
undocumented behaviour of a client we do not control.** It works in v2.1.235. It
may not work in v2.2, and there would be no announcement. If rotorcc deletes its
successor path today, then on the day that behaviour changes, rotation stops
working — silently, because everything else still runs. That is precisely the
failure family this project exists to stop, and it would be self-inflicted.

So the claim ADR 0002 was built on is not "wrong" so much as **not currently
true, and possibly true again later**. Architecture that survives both states is
the only architecture worth building here.

### Verification is the whole of `auto`

`auto` must not treat "the file was written" as success. A hot-swap that
silently did not take is worse than no hot-swap at all: the session keeps
burning the exhausted account while rotorcc reports a rotation. So the swap is
verified against positive evidence that the live process is now on the new
account, with a bounded deadline, and on timeout or mismatch it falls back to
the successor path. Every rotation records which mode was used and why, so that
months from now it is answerable from the log whether hot-swap still works in
the wild.

### What does not change

- **The judgement in ADR 0002 stands.** The weekly window decides; a spent
  5-hour window with a healthy week waits rather than spending another account's
  week; when every account is spent rotorcc STOPS rather than rotating onto an
  exhausted one. Hot-swap changes the mechanism, not the decision.
- **The work-aware guard stands.** Never rotate — by either mechanism — over
  work rotorcc cannot save. Checkpoint first, always.
- **The liveness gate stands, untouched.** In `successor` mode a successor must
  never launch beside a live predecessor. Hot-swap does not reach that gate; it
  is not an excuse to weaken it.

## Consequences

### Gains

- Rotation with **no cold start, no lost context, no seam and no new pane**. The
  duplicate-session hazard does not arise because no second process exists.
- The handover queue from ADR 0002 is still the cheapest moment to switch, and
  stays as the preferred path when a session is about to start anyway.
- `launchSuccessor` narrows to the job it should always have had: replacing a
  session whose process is **gone**.

### Accepted costs

- **Two mechanisms to maintain and test**, and an `auto` path that has to decide
  between them correctly.
- **A dependence on undocumented behaviour**, entered deliberately and with the
  fallback already built rather than promised.
- **The verification step costs a request.** Confirming a swap took effect means
  observing the live session's account, which is not free. It is worth it: an
  unverified swap is a rotation rotorcc cannot honestly claim to have made.

## The rule, again

> A tool that lies about its own state is worse than no tool.

ADR 0001 applied that to measurement. ADR 0002 applied it to action. This one
applies it to **the tool's own beliefs about the world**: an assumption that has
never been tested is not knowledge, and building an architecture on one is how
you end up with a correct implementation of the wrong thing.
