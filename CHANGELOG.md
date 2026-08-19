# Changelog

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project uses [semantic versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] — rotation without replacing the session

### Fixed — a data-loss defect in the sweep (P0, 2026-08-19)

The checkpoint sweep committed a **stale worktree over newer work** on one
branch three times in forty minutes and pushed each time. The shape was a loop
rather than a one-off race: committing advanced the branch, advancing the branch
re-dirtied the stale tree, and the next sweep committed it again. The branch
survived only because a human's push happened to land last.

Two guards, both cheap, both structural:

- **A plan is void if the tree moved under it.** `inspectTree` records the exact
  HEAD it read; `checkpointTree` re-reads HEAD immediately before staging and
  refuses if it changed. Every fact the sweep acts on may be seconds old —
  discovery inspects four trees at a time with a transcript snapshot in between.
- **A push must be a genuine fast-forward, checked here.** The upstream must be
  an ancestor of the local tip. Leaving it to the server means the bad commit
  already exists and the operator gets a push error to decode instead of a
  refusal that names the problem.

A tree that is behind still gets its dirty work **committed** — durability is
the point — it just never gets published over the newer history.

### Fixed — the selector ranked incomparable windows (P0)

`headroomPct` is the _binding_ window's headroom, and the binding window differs
per account, so `sort by headroomPct` compared "10% of a week" with "1% of five
hours" as though they were one quantity. On the live reading that exposed it,
rotorcc ranked an account whose week is nearly gone — and does not recover for
five days — above one whose only constraint was a five-hour window resetting in
twenty minutes, after which it still held 28% of its week.

Ranking is now on the **weekly budget** (the resource an operator regrets
spending, which is the judgement ADR 0002 already made) with **readiness** as
the gate: the 5-hour window has room now, or resets inside the planning horizon.
An unready account ranks last rather than being excluded. An unknown reset time
makes an account unready, never "probably back soon".

`decide.ts`'s `pickTarget` was a second selector with its own sort, so the
watcher and `rotorcc switch` could choose differently from one reading. It now
delegates to `selectTarget`.

### Changed — rotation happens under the live session (see ADR 0003)

ADR 0002 asserted that a Claude Code process reads its credential once at launch,
so a new process was the only rotation there was. **That was never tested, and
it is false.** A session reads its credential per request: swapping in an invalid
token failed the very next turn, restoring a good one recovered in place with the
conversation intact, and swapping in a _different account's_ credential let the
same conversation continue and complete a full generation. Method and
observations in [ADR 0003](docs/adr/0003-live-credential-hot-swap.md).

- `rotation.mode` is `auto` | `hotswap` | `successor`, defaulting to `auto`.
- **hotswap** changes the credential under the running session. No successor, no
  new pane, no cold start, no lost context, and the duplicate-session hazard
  cannot arise because no second process exists.
- **successor** is the old path, kept fully working and **not deprecated**.
  Hot-swap is undocumented behaviour of a client nobody here controls; deleting
  the fallback would mean rotation breaks silently on the day it changes.
- **auto** verifies and then falls back — on _evidence of failure_, never on the
  absence of evidence of success. A session that made no request during the
  watch is reported `unobserved`, not `verified`, and is not replaced for it.
- The swap is `switchAccount`, unchanged, not a quick write of
  `.credentials.json`. The same experiment found `/status` keeps naming the OLD
  account when only that file moves, because the identity block lives in
  `~/.claude.json`. A session on one account while every surface names another
  is this project's signature defect in a new hat.
- The liveness gate is untouched: a successor still never launches beside a live
  predecessor.

### Changed — rotorcc reports what has been USED, not what is left

Anthropic's API reports utilisation and so does Claude Code's status line;
rotorcc reported headroom, so comparing two screens meant inverting one in your
head. That produced a mislabelled table. Every human surface now shows used —
and **always with the window**, because `99% (5h)` returns within the hour and
`99% (7d)` does not, and a bare `99%` cannot tell them apart.

- Thresholds print in the same direction as the numbers beside them: "warn at
  85% used", not "warn 15%".
- **`--json` is additive.** `usedPct` and `window` are new; `headroomPct` keeps
  its original meaning. Inverting a field while keeping its name would make an
  existing consumer read `99` as healthy when it means nearly gone.
- Found while doing it: `renderStatus` printed `headroomPct` with no
  `headroomIsKnown` guard, so an unmeasurable account appeared as "0% left" on
  the most-read screen in the tool. It now draws no bar and no number.

### Added

- **`rotorcc upgrade [--check]`** — detects whether this machine has a package
  install or a git checkout and does the right thing for each. Fast-forward only;
  refuses a dirty tree, a diverged branch, a detached HEAD, an untracked branch,
  or a checkout whose `dist/` is not what PATH resolves to. The build is staged
  and published by rename, so a failed build never touches the live `dist/`, and
  the upgrade holds rotorcc's tick lock so a watcher tick declines loudly instead
  of running against half-installed files. Verification runs through the **new**
  binary, because a check made by the old process is a check of the build that
  was just replaced.
- **`rotorcc accounts unclaimed [--purge <id>]`** — surfaces credentials the
  roster no longer claims, with slot, login, age, fingerprint and the reason.
  Purge is by exact id and needs `--yes`; there is no bulk form.
- **`rotorcc purge`** — enumerates every path it would delete, with sizes and
  with what is irreversible marked, and deletes nothing without `--yes`. Claude
  Code's own credential, config and home are listed under "NOT touched".
- **`rotorcc accounts --token-status`** — which store each credential came from,
  its expiry, and whether it can be refreshed. Fingerprints and states only; no
  token is ever printed.
- **`daemon --once` exit codes**: `0` nothing to do, `1` acted, `2` would act but
  could not, `3` error. Documented in `--help` and the README and pinned by
  tests. A tick skipped because another operation held the lock is a `2`, never
  a `0` — it did not look, so it cannot say there was nothing to see.
  **Breaking**: `1` previously meant "error".
- npm publishing metadata, and a `prepublishOnly` that runs the leak audit, the
  typecheck, the whole suite and a fresh build.

### Fixed — `pnpm install` failed on a perfectly good tree

pnpm 11 treats an undeclared ignored build script as an install **failure**, and
`pnpm-workspace.yaml` still carried the placeholder pnpm writes when it asks. So
every script that runs a dependency check first — which is all of them — failed
on a tree that was completely fine. `rotorcc upgrade` also names that specific
failure, with its fix, rather than reporting it as generic install noise.

**572 tests, up from 445.**

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
