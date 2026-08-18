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

### Fixed (found in production dogfood, 2026-08-18)
- A `ROTATE_NOW` flag written by a `--dry-run` rotation survived on disk and was
  surfaced by the `UserPromptSubmit` hook to a healthy live session hours later
  (real level `ok`, 72% headroom, `rotation.enabled=false`) — the orchestrator was
  told to exit on a false alarm. Fix: dry runs never write flags outside a scratch
  dir; the hook cross-checks a flag's `raisedAt` against `state.lastLevel` and the
  current usage read and drops a flag whose level no longer holds (logged as
  `stale-flag-dropped`); flag files carry a TTL (default 30 min).
