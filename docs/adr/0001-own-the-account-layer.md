# ADR 0001 — rotorcc owns its account layer

- **Status:** accepted
- **Date:** 2026-08-19
- **Supersedes:** the original design, in which rotorcc shelled out to an
  external account switcher for every account operation.

## Context

rotorcc started as a durability tool. It snapshotted transcripts, checkpointed
worktrees, wrote resume manifests and launched successor sessions — and for the
one thing it could not do itself, changing which Claude account was active, it
ran `cswap`. That was a reasonable first cut: account switching is a solved
problem, `cswap` solves it well, and composing beats duplicating.

It also produced three production defects, all of the same shape.

1. **2026-08-18** — a `ROTATE_NOW` flag written by a dry run survived on disk
   and was handed to a healthy live session hours later. 72% headroom, rotation
   disabled, and the orchestrator was told to stop dispatching work and exit.
2. **2026-08-18** — a `--dry-run` rotation wrote a manifest whose every row read
   "would commit 345 file(s)". The resume banner presented those simulated rows
   as a rescue record while thirteen trees sat unpushed for twenty hours.
3. **2026-08-19** — one account emitted `"usage": null`. The zod schema used
   `.optional()`, which accepts `undefined` and rejects `null`, and the call
   site used `.parse()`. One bad entry discarded all three accounts. `status`
   printed "accounts unreadable", no rotation ever fired, and the operator
   burned to 99% while two healthy accounts sat at 45% and 91%.

The common thread is not "rotation is hard". It is that **rotorcc reported
confidently while doing nothing.** In every case the tool was running, the
watcher was ticking, and the screen looked plausible.

Defect 3 is the one that bears on this decision directly. rotorcc did not
own the usage read; it owned a _parser for someone else's output_. That is the
worst of both worlds: all of the coupling, none of the control. When the shape
changed — or when one entry within it was null — rotorcc had no way to degrade,
because the only thing it had was a string to parse and a schema to reject it
with.

Two further constraints arrived from the Director:

- rotorcc must work on a machine with no external switcher installed at all.
- Removing the dependency is an explicit goal, not a nice-to-have.

## Decision

**rotorcc owns the whole account layer natively:** credential storage, the
switch mechanism, quota reading, the roster, slot management, strategies,
directory mappings, and single-terminal execution. No external switcher is
required, invoked, or depended upon at runtime.

Concretely, rotorcc now:

- reads and writes Claude Code's active credential across the macOS Keychain,
  `~/.claude/.credentials.json`, and `~/.claude.json` `primaryApiKey`, holding
  Claude Code's own `proper-lockfile` credential and config locks while it does;
- keeps a per-account credential stash of its own, 0600, with one retained
  previous generation as a recovery cushion;
- fetches quota directly from `https://api.anthropic.com/api/oauth/usage` using
  the operator's own OAuth token, and refreshes that token against
  `https://platform.claude.com/v1/oauth/token` when it expires;
- caches quota per account with the age attached, honours a poll floor and the
  server's `Retry-After`, and serves last-good data _labelled as such_.

An external switcher is still detected in exactly two places, both migration
concerns and neither a dependency:

- `rotorcc accounts import --from-cswap` reads its store **once**, read-only, to
  copy accounts across so nobody has to re-authenticate by hand.
- If rotorcc manages no accounts of its own, `readUsage` and `performSwitch`
  fall back to the external switcher rather than reporting nothing — and every
  message on that path says which source produced the number.

`rotorcc doctor` no longer treats the external switcher as a required
dependency. It fails when rotorcc has no accounts of its own and offers the
import as the fix.

## Why not keep composing

The composing argument is genuinely good, and it is the argument I would make
for most dependencies. It loses here for four specific reasons.

**1. The failure surface is the wrong shape.** Delegating a _command_ is cheap.
Delegating a _fact_ is not. rotorcc's entire policy — every threshold, every
latch, every refusal — is a function of one number per account. Getting that
number by parsing another program's stdout means the number can become
unavailable for reasons rotorcc cannot see, cannot classify, and cannot degrade
around. Defect 3 was exactly this: rotorcc could not distinguish "this account
has no headroom" from "this account's entry did not parse", because at the
boundary it had already been reduced to a thrown exception.

Owning the fetch means owning the failure taxonomy: `http-429` with a
`Retry-After`, `timeout`, `unauthorised`, `invalid_grant`, `no_refresh_token`.
Each of those is a different thing to tell the operator and a different thing to
do next. None of them survives a subprocess boundary intact.

**2. Version coupling on a safety-critical path.** rotorcc parsed `list --json`.
That is an interface, but not a stable one — it belongs to another project with
its own release cadence and no obligation to us. A switcher upgrade that
reshapes its output makes rotorcc stop rotating, and the failure is silent
because everything else still runs. "Degrade loudly on a switcher upgrade" was a
requirement precisely _because_ the coupling existed; removing the coupling
removes the requirement.

**3. The differentiators need the internals.** Work-aware rotation has to filter
candidates by whether they can _finish_ the running work, which needs per-window
data, reset times and burn history per account. Predictive rotation needs a
sample series keyed by quota window so a rollover starts a fresh fit instead of
a line through a discontinuity. The TUI needs the age of every measurement and
the reason behind every unknown. All of that exists inside a switcher and none
of it survives being flattened into a status line. We would have ended up
re-deriving it from repeated polls anyway — worse, and with a subprocess per
poll.

**4. The dependency was doing less work than it appeared to.** Once the quota
read is native, what remains to delegate is: write a file, hold two locks, splice
one JSON key. That is roughly six hundred lines including the paranoia, and the
paranoia is where the value is. Shelling out to another process to do it buys
nothing and costs the ability to roll back a half-completed switch.

## Consequences

### Accepted costs

- **rotorcc now makes network calls.** Two, both to Anthropic, both on the
  operator's own credential, both in one module (`src/accounts/oauth.ts`) so the
  claim is verifiable by reading one file. There is no telemetry, no analytics,
  no update check, and no third-party host. This is a real change to the
  project's surface and is documented in the README rather than buried.
- **rotorcc now handles credentials.** This is the serious one. It is mitigated
  by: 0600 set on the file descriptor before any secret exists in the file;
  atomic publication by rename; a branded `Secret` type so logging one is a type
  error; secrets passed to the macOS keychain on stdin, never in argv; and a
  `Secret` never appearing in an error message, a log line, or the decision
  journal.
- **We inherit Anthropic's endpoint contract.** If the usage response reshapes,
  rotorcc must adapt. Mitigated by parsing every field as nullish and every
  window as optional, so an unrecognised or absent piece costs that piece and
  not the read — the direct lesson of defect 3.
- **More code to maintain.** About 2,400 lines and 160 tests more than the
  delegating design.

### Gains

- An account rotorcc could not measure is reported as _unmeasured_, with the
  reason, everywhere: `null` in JSON, the word `unknown` on screen, and excluded
  from every strategy's candidate list. Defect 3 is structurally unavailable.
- Rotation can refuse. It knows about worktrees, unpushed commits and running
  agents, so it can decline to move while work is somewhere it cannot save.
- A switch is a transaction with a rollback, rather than a subprocess whose
  partial failure is invisible.
- rotorcc installs and works with nothing else on the machine.

## The rule this ADR exists to serve

> A tool that lies about its own state is worse than no tool.

Every design choice above resolves toward that. Where rotorcc cannot be certain,
it says so — in the JSON, on the screen, in the log, and in the decision it
takes. `unknown` is a first-class value in this codebase, and any change that
makes an unknown render as a number is a defect regardless of how good the
number looks.

## Attribution

The protocols this implementation is built on — Claude Code's credential paths,
its two-lock refresh protocol and their staleness values, the keychain-before-file
read order, the OAuth/API-key mutual exclusion, the machine-shared MCP fields,
the usage endpoint and its `limits` array — were learned by reading
[claude-swap](https://github.com/realiti4/claude-swap) (MIT, Onur Cetinkol).
Several are load-bearing safety properties that are not obvious and would most
likely have been found the expensive way. See `THIRD-PARTY-NOTICES.md`.

rotorcc is an independent TypeScript implementation, not a port of that source,
and claims no affiliation with it.
