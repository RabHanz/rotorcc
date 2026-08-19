# Changelog

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project uses [semantic versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased — native account ownership

rotorcc now owns its whole account layer: it stores its own logins, reads quota
straight from Anthropic, and switches accounts itself. No external switcher is
required, wrapped, or depended upon at runtime. See
`docs/adr/0001-own-the-account-layer.md` for the ruling and what it rejects.

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
decided; pinned by `test/unknown-is-unknown.test.ts`. 400 tests (was 238).

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

### Added — rotorcc owns its account layer (2026-08-19)

rotorcc no longer shells out to an external account switcher. It manages its own
accounts end to end: credential storage, the switch, quota reading, the roster,
strategies, mappings. It works on a machine with no other switcher installed.

The reasoning, and the four arguments against continuing to compose, are in
[ADR 0001](docs/adr/0001-own-the-account-layer.md). The short version: rotorcc's
whole policy is a function of one number per account, and getting that number by
parsing another program's stdout meant it could become unavailable for reasons
rotorcc could not see, classify, or degrade around. That is the 2026-08-19
outage exactly.

- **Credentials.** `src/accounts/credentials.ts` reads and writes Claude Code's
  active login across the macOS Keychain, `~/.claude/.credentials.json` and
  `~/.claude.json`, with a per-account stash of rotorcc's own. Every write is
  atomic with `0600` set on the descriptor before any secret exists in the file.
  "Absent" and "unreadable" never collapse into one answer. A credential read
  from a backend that may lag is marked degraded and is never refreshed — a
  refresh token is one-time, and spending a superseded one yields
  `invalid_grant`, which looks exactly like a dead account.
- **Locking.** `src/accounts/ccLock.ts` holds Claude Code's own
  `proper-lockfile` credential and config locks, in Claude Code's order, at its
  60s/10s staleness. Without this, a switch landing inside Claude Code's token
  refresh is overwritten by the refreshed _old_ account's token and the backup
  just taken holds a spent refresh token.
- **Quota.** `src/accounts/oauth.ts` fetches `api.anthropic.com/api/oauth/usage`
  directly and refreshes tokens against `platform.claude.com/v1/oauth/token`.
  These are rotorcc's only network calls, both to Anthropic, both on the
  operator's own credential. Every field parses as nullish and every window as
  optional, so an absent or unrecognised piece costs that piece and not the read.
- **Cache.** Last-good windows per account **with their age**, a three-minute
  poll floor, exponential backoff, and the server's `Retry-After` honoured. A
  failed read never becomes a percentage.
- **The switch.** A five-step transaction with per-step rollback, all inside the
  locks. It captures the account being left **before** activating the new one:
  Claude Code rotates the live refresh token whenever it likes, and the copy
  stashed at add-time is dead the moment it does.
- **Migration.** `rotorcc accounts import --from-cswap` reads another switcher's
  store once, read-only, one slot at a time so a corrupt entry costs that slot
  and no other. It never modifies the source, and does not inherit its opinion
  of which account is active — rotorcc establishes that by fingerprinting the
  real credential on the machine.

### Added — what makes rotorcc better than a headroom-only switcher

- **Rotation that knows about work in flight.** Before rotating, rotorcc looks at
  every watched worktree. Work it _cannot_ save — protected branch, mid-rebase,
  no remote — is a **refusal**, not a warning: rotating ends the session that
  owns it. And a target without enough headroom to _finish_ the running work is
  refused rather than accepted as the least bad option.
- **`rotorcc tui` / `rotorcc watch`.** A real terminal dashboard: per-account
  headroom with the binding window and its reset, burn prediction with
  confidence, unsaved work per tree and whether rotorcc could save it, snapshot
  age, watcher health, and the last N decisions with the reason each was taken
  or refused. Pure renderer, so the honesty rule is tested rather than eyeballed.
  Colour from the terminal's own 16 colours, `NO_COLOR` honoured, SSH-safe.
- **`rotorcc predict`.** Least-squares burn rate per (account, quota window),
  with the sample count, the span, R², and a confidence that never reads `high`
  without about an hour of well-fitted data. A window rollover starts a fresh
  series instead of fitting a line through the discontinuity. Not enough
  history reports `unknown`, never a number.
- **The decision journal.** Every tick is recorded, **including the idle ones**,
  with the reason. On 2026-08-19 the watcher decided "do nothing" for hours and
  nothing recorded that it had. `tui` shows a run of consecutive do-nothing
  decisions beside the headroom that caused them.
- **`doctor` upgraded.** It no longer treats an external switcher as a
  dependency. It checks the account store, identifies the active account by
  credential fingerprint (and **warns** when the live login is one rotorcc does
  not manage, since every threshold here is about the active account), reports
  the measured/unmeasured split, counts viable rotation targets, and names the
  strategy in force.
- **The rest of the surface**, natively: `accounts add`/`add-token`/`remove`/
  `alias`/`disable`/`enable`/`swap`/`move`/`export`, `switch --strategy`,
  `run <ref> -- cmd` for a single terminal, `map`/`unmap` for
  directory→account bindings, `--json` on every read command, `--model`.

### Fixed (production, 2026-08-18) — two defects that were specified but never coded

Found while writing their regression tests. The entries below in this changelog
described both fixes as done. **Neither was in the source**, and both were still
reachable in the shipped code.

- **A dry run raised a real `ROTATE_NOW` flag.** `store.raiseFlag` ran _before_
  the `dryRun` branch in `rotate()`, with no TTL and no cross-check. A simulated
  rotation could therefore tell a healthy live session hours later to stop
  dispatching work and exit — which is what happened, at 72% headroom with
  rotation disabled.

  Now: dry runs raise nothing. Flags carry the level they were raised at and an
  expiry (30 minutes by default). `readFlag(name, { currentLevel, nowMs })`
  **deletes** a flag that has expired or whose level no longer holds, rather than
  filtering it — leaving it on disk means the next reader that forgets the check
  obeys it. The hook passes `state.lastLevel`, since a hook is the one place a
  flag becomes an instruction to a running agent.

- **A dry-run manifest could be read as a rescue record.** It was written into
  the real manifests directory with no marker, so `latestManifest()` returned it
  and the resume banner presented rows reading "would commit 345 file(s)" as
  proof of work saved — while thirteen trees sat unpushed for twenty hours.

  Now: `Manifest.dryRun`; simulated manifests go to `manifests/dry-run/` where no
  resume path reaches them; the Markdown opens with a banner _before_ the title;
  and `state.lastManifestPath` is never set from one.

- Also: the hook printed `0% headroom left` whenever the figure was simply
  absent — a number invented from a missing field, and the most alarming one
  available. It reads `headroom unknown` now.

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
