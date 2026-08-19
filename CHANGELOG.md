# Changelog

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project uses [semantic versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased — native account ownership

rotorcc now owns its whole account layer: it stores its own logins, reads quota
straight from Anthropic, and switches accounts itself. No external switcher is
required, wrapped, or depended upon at runtime. See
`docs/adr/0001-own-the-account-layer.md` for the ruling and what it rejects.

### Changed — rotation is a handover, not an interruption (2026-08-19)

The fourth defect of the same family, and the one that forced a redesign rather
than a fix. rotorcc opened a second `claude --continue` onto a session that was
alive and working: two operators, one worktree.

`5258e96` fixed the immediate causes (a subagent's limit message read as the
operator's; a successor launched despite a known-live predecessor). But that was
a guard on a model that was wrong. The Director's question — _how does it stop a
running session when work is already being done?_ — has one honest answer: **it
cannot.** A Claude Code process reads its credential once, at launch. The old
"checkpoint, switch, spawn a successor" design was therefore abandon-and-replace,
and a new pane appearing was not a bug in it, it _was_ it.

Full reasoning in [ADR 0002](docs/adr/0002-handover-not-interruption.md).

- **The weekly window is the priority signal.** The 5-hour window refills several
  times a day; the 7-day one is the budget an operator regrets spending early. A
  spent 5-hour window with a healthy week now checkpoints and **waits** instead
  of burning another account's week to escape something that returns in hours.
  New `weeklyRotatePct` (default 5, i.e. 95% utilised) and `weeklyWarnPct` (20).
  Per-model weekly caps fold into the weekly figure, because that is what they
  are.
- **A switch changes the account the NEXT session opens on.** `src/core/nextSession.ts`
  records the intent; the `SessionStart` hook consumes it and switches before the
  session begins. Nothing is interrupted, no successor is spawned, and a
  duplicate is structurally impossible rather than merely guarded. The intent is
  consumed exactly once and expires — this project has already shipped a defect
  where a stale instruction was obeyed hours later.
- **When every account is spent, rotorcc STOPS.** No rotation, no successor, and
  no queued intent either — a handover onto an account with 4% of its week left
  only moves the problem. It checkpoints, writes the manifest, raises a dedicated
  `ALL_ACCOUNTS_EXHAUSTED` flag and prints a notice naming every account, its
  headroom and its reset time. An account that could not be **measured** says so
  rather than being omitted: "we could not read this" and "this is empty" mean
  different things and only one of them means waiting will help.
- **A successor is only ever a replacement for a dead process.** Never a
  companion to a live one.
- **The hooks are the intelligence layer.** `SessionStart` is where rotation
  happens; the 60-second watcher becomes the safety net for genuinely dead
  sessions rather than the primary mechanism.
- The policy paths are **latched**, or a low window would mean a commit and a
  push every sixty seconds for hours (the 2026-08-18 defect), and a full-screen
  stop banner every minute would train an operator to scroll past the one
  message that matters.
- `rotation.enabled: false` now suppresses the queued handover too, since an
  intent `SessionStart` would act on is still rotorcc switching by itself, just
  later. It still names the account to move to — refusing to act is not a reason
  to refuse to inform.
- `rotorcc tui` and `rotorcc status` show the queued handover, and say plainly
  when there is none.

### Fixed — nine findings from an independent review (2026-08-19)

A reviewer with no context read the diff cold and returned five P1 and four P2.
All nine were real; none were refuted. Notably: a switch could report "nothing
was written" **after** activating the target; a background quota poll refreshed
tokens without holding Claude Code's credential locks; an uninspectable project
was classified savable rather than needing a human, letting a rotation proceed
past a repository whose git state had never been read; and `rotorcc run` left a
plaintext credential in the temp directory on Ctrl-C.

### Added

- Native account layer (`src/accounts/`): credential storage (macOS Keychain,
  `~/.claude/.credentials.json`, `~/.claude.json`), a switch transaction with
  rollback held inside Claude Code's own locks, quota reading from
  `api.anthropic.com/api/oauth/usage` with a cache and poll floor, and OAuth
  refresh with a one-time-token discipline.
- `rotorcc accounts` (`list`/`add`/`add-token`/`remove`/`alias`/`disable`/
  `enable`/`swap`/`move`/`import --from-cswap`/`export`), `rotorcc switch`,
  `rotorcc run <ref> -- …`, `rotorcc map`/`unmap`.
- `rotorcc tui` / `watch` — live terminal dashboard; `rotorcc predict` — burn
  rate and time-to-threshold with stated confidence.
- Work-aware rotation: refuses to rotate over work it cannot save, and refuses
  a target too small to finish what is running (`strategy`,
  `refuseRotationWithUnsavedWork`).
- Predictive rotation (`src/core/burn.ts`) and a decision journal
  (`src/core/history.ts`) that records every tick, idle ones included.
- `doctor` upgraded; `THIRD-PARTY-NOTICES.md` crediting claude-swap (MIT).

### Fixed — two 2026-08-18 defects the changelog claimed but never coded

- A dry run raised a real `ROTATE_NOW` flag. Now dry runs raise nothing; flags
  carry a level and a 30-minute TTL; `readFlag` deletes an expired or
  level-invalid flag rather than filtering it.
- A dry-run manifest landed in the real manifests directory and was read as a
  rescue record. Now `Manifest.dryRun`, a separate `manifests/dry-run/`
  directory, a banner, and never `state.lastManifestPath`.
- The hook printed "0% headroom left" for a missing figure; it says "headroom
  unknown" now.

The rule, made structural: an unmeasured account reports `unknown` (null in
JSON), never a number, everywhere. `headroomIsKnown()` is the one place that is
decided; pinned by `test/unknown-is-unknown.test.ts`.

**441 tests, up from 238.** The ones worth reading are
`test/unknown-is-unknown.test.ts` (the rule, walked across every surface that
could break it), `test/policy.test.ts` (the four rotation rules) and
`test/credentials-switch.test.ts` (the ways a switch could destroy a login).

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
