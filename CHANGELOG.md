# Changelog

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project uses [semantic versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — unreleased

First release.

### Added

- Continuous durability: hooks on `SessionStart`, `UserPromptSubmit`,
  `SubagentStop`, `Stop`, `PreCompact` and `SessionEnd` that snapshot transcripts
  into a git store and commit and push every watched worktree. The heavy half
  runs detached, so a hook never blocks a tool call.
- Predictive rotation: a one-minute tick reading live per-account headroom, with
  warn / soft-checkpoint / rotate thresholds, per-window latches, a hysteresis
  band, a cooldown, and a refusal to rotate when no account has room.
- Resume manifest, as machine JSON and a human handover note: session id and
  transcript, the background-task registry, every tree's branch/tip/unpushed/
  dirty/push-result, collected resume notes, account headroom, optional open
  pull requests, optional extra command output, and the next commands.
- Successor launch through tmux or screen, with readiness detection, workspace
  trust-dialog detection, a send-keys fallback, and opt-in retirement of the
  predecessor's window after its transcript goes quiet.
- Hard-kill detection: configurable limit signatures in the transcript tail, and
  an idle-transcript-plus-no-process liveness check.
- Crash reconstruction on `SessionStart`, injecting the resume plan as the new
  session's first context.
- Secrets screen over each snapshot's delta, refusing the off-machine mirror on
  a hit while still making the local copy.
- Scheduler adapters for systemd user timers, launchd agents and Task Scheduler,
  plus a foreground `daemon` loop for anything else.
- `init`, `install-hooks`, `uninstall-hooks`, `install-scheduler`,
  `uninstall-scheduler`, `daemon`, `snapshot`, `push-unpushed`, `manifest`,
  `status`, `resume`, `config`, `doctor`, `hook`.
- `--dry-run` on every command.
- Typed configuration with a zod schema and `rotorcc config validate`.

## Unreleased

### Fixed (production, 2026-08-19) — the defect that cost a session

- **One unreadable account blinded the whole reader, and no rotation ever fired.**
  The operator burned to 99% of their limit while the watcher ticked every 60
  seconds and `status` printed `accounts unreadable — expected object, received
null`. Two healthy accounts (45% and 91% headroom) were sitting right there.

  Three compounding causes, all in `src/core/usage.ts`:
  1. The switcher emits `"usage": null` for an account whose quota it could not
     fetch — a token needing re-auth, a transient API failure, an account not yet
     polled. The schema used `.optional()`, which accepts `undefined` and
     **rejects `null`**.
  2. The call site used `.parse()`, which throws on any failure, so one bad entry
     discarded every good one.
  3. Nothing downstream distinguished "no headroom" from "unknown headroom".

  Now: `.nullish()` on every optional usage field; accounts parsed
  **individually** with `safeParse`, so a malformed entry costs that account and
  no other; an account with null or absent usage is reported **stale with 0%
  headroom** — never rotated onto, never silently dropped; and any account numbers
  that failed to parse come back on `UsageReading.unreadableAccounts` so `status`
  and `doctor` can say so out loud. Four regression tests in
  `test/usage-partial-read.test.ts` pin the exact production payload, including
  the literal `"usage": null` entry.

  The principle this violated: **a rotation harness that fails closed on a partial
  read is worse than no harness — it reports confidently and does nothing.** This
  is the third defect of that shape (both below), and the first to cost real work.

### Fixed (found in production dogfood, 2026-08-18)

- Routine hook events (`SubagentStop`, `Stop`, `UserPromptSubmit`) committed every
  dirty tree with a `wip(rotorcc)` commit and pushed it. On a busy orchestrator
  (48 trees, one perpetually-dirty from build artefacts) that meant a commit-and-
  push every few minutes, which polluted branch history, switched the operator's
  own checkout under them, and cancelled the project's CI run on every push. New
  `commitDirty` option on `checkpointTree`/`performCheckpoint`: routine hooks pass
  `false` and only push what agents already committed; `SessionEnd`, rotation and
  crash reconstruction keep `true` — the moments uncommitted work would actually be
  lost. Two tests pin the routine behaviour. `includeMainTree` should be `false`
  for an orchestrator's own checkout (documented in ROTOR setup).
- A `ROTATE_NOW` flag written by a `--dry-run` rotation survived on disk and was
  surfaced by the `UserPromptSubmit` hook to a healthy live session hours later
  (real level `ok`, 72% headroom, `rotation.enabled=false`) — the orchestrator was
  told to exit on a false alarm. Fix: dry runs never write flags outside a scratch
  dir; the hook cross-checks a flag's `raisedAt` against `state.lastLevel` and the
  current usage read and drops a flag whose level no longer holds (logged as
  `stale-flag-dropped`); flag files carry a TTL (default 30 min).
