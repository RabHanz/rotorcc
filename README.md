# rotorcc

Long agent sessions end badly in two ways. You hit a rate limit mid-tool-call
and the process dies with an hour of uncommitted work in six worktrees. Or you
switch accounts to keep going, and the switch takes effect only in a _new_
process — so the running one dies anyway, at a moment nobody chose.

rotorcc watches your account headroom, checkpoints continuously so the loss
window is one tool call, and when the window is nearly gone it writes a resume
plan, switches accounts and starts the replacement session pointed at that plan.

It is a CLI for Claude Code power users who run several accounts and leave
agents running for hours. Node ≥ 20, one runtime dependency (zod), Linux, macOS
and Windows.

**rotorcc manages its own accounts.** It stores your logins, reads your quota
from Anthropic directly, and switches accounts itself. It does not require, wrap
or shell out to any other switcher — see [what it owns](#what-rotorcc-owns) and
[ADR 0001](docs/adr/0001-own-the-account-layer.md) for why.

## The one rule

> **rotorcc never invents a number.**

An account it could not measure reports the word `unknown` with the reason, and
`null` in `--json`. Never `0`, never `100`, never a bar on a screen. This is not
a style preference. rotorcc has had three production defects of the same shape —
it reported confidently while doing nothing — and one of them cost a working
session. Any change that makes an unknown render as a number is a defect here,
however plausible the number looks.

## 60-second quickstart

```bash
npm install -g rotorcc

rotorcc accounts add            # capture the login Claude Code is using now
# ...or, if you already use another switcher:
rotorcc accounts import --from-cswap

rotorcc init                    # detects ~/.claude and your project
rotorcc install-hooks ~/code/my-project
rotorcc install-scheduler       # a one-minute tick: systemd, launchd or Task Scheduler
rotorcc doctor                  # confirms every assumption it makes
```

Install it as a **package**, not as a checkout, unless you are working on
rotorcc itself. A global install has one copy and one version; a checkout that
somebody linked onto their PATH months ago is how you end up rebuilding one
rotorcc and running another. `rotorcc upgrade` handles both, and says which
shape it found.

That is the whole setup. From then on:

```bash
rotorcc tui                     # the live dashboard
rotorcc status                  # the same facts, printed once
```

```
rotorcc 0.2.0                                                            20:20:47

ACCOUNTS — how much of each window has been SPENT
 ▸ #1  work              *5h ███████ 100% used   7d ████░░░  61% used  5h binds · resets 19 Aug 20:30
   #2  spare              5h ██░░░░░  24% used  *7d ████░░░  55% used  7d binds · resets 24 Aug 09:00
❯  #3  personal           5h unknown            7d unknown            binding window unknown — http-429
  * the window that binds · thresholds: warn at 85% used · soft at 90% · rotate at 95% · strategy work-aware

PREDICTION
  reaches 95% used in 2.3h
  18.4 points/hour · medium confidence · least-squares fit over 14 samples
  spanning 41 minutes (R²=0.79)
  work finishes first? likely no — 45% headroom on 5h is under the estimated 62% needed

WORK IN FLIGHT
  6 tree(s) hold work that is not on a remote (1 rotorcc cannot save on its own)
    work/parser                     +2      4 dirty    savable
    main                            +1      0 dirty    protected branch
  1 session(s) written to in the last 5 minutes, 3 known
  WOULD REFUSE TO ROTATE — 1 tree(s) hold work rotorcc cannot save on its own

DURABILITY
  snapshot     2m ago
  store        8f3a1c2 snapshot: hook:Stop 2m ago
  watcher      systemd timer active

RECENT DECISIONS
  20:19 refused       88% used   unsaved work on a protected branch; checkpointed instead
  20:18 checkpointed  86% used   soft checkpoint requested
  20:17 idle          84% used   nothing to do
```

Every row carries **both windows**, each labelled, each as the share that has
been spent. That is not decoration. Account #1 is out of its five-hour window
and still has 39% of its week: it is unusable for the next forty minutes and
perfectly healthy after that. Showing only the window that binds made those two
situations look identical, and reported an account as dead when it was not.

Account #1's 5h bar is **full at 100% used** — a real measurement of a spent
window. Account #3 has **no bar at all on either window**, because a full bar
and a genuine "we could not read this" look identical and only one of them is a
measurement.

The `❯` on account #3 is the cursor. The dashboard is a control surface, not a
read-out: from it you can switch to an account, rotate to the best one, disable
one, re-poll quota, change strategy, and ask why nothing has happened — without
leaving the pane. Press `?` for the keys.

## Updating

```bash
rotorcc upgrade                 # fetch, install, rebuild, re-verify, run doctor
rotorcc upgrade --check         # is there a new one? (0 current, 1 available)
```

It works out for itself whether this machine has a **package install** (it
reinstalls from the registry) or a **git checkout** (it fast-forwards, reinstalls
dependencies and rebuilds), and it refuses rather than improvises:

- a dirty tree, or a branch that has **diverged** from its remote. Fast-forward
  only, always. There is no merge, no rebase and no reset anywhere in that path.
- a checkout whose `dist/` is not what your PATH actually resolves to. Upgrading
  a copy you do not run is the failure that makes every later bug report be
  about code that was never deployed.

It is safe to run while the watcher is ticking. The build is staged in a
temporary directory and swapped in by rename, so a failed build never touches
the `dist/` you are running from, and the upgrade holds rotorcc's own tick lock
so a watcher tick that lands mid-upgrade declines and says so (exit 2) rather
than running against half-installed files.

Afterwards it asks the **new** binary for its version and runs its `doctor`,
because a check made by the old process is a check of the build you just
replaced.

### Updating a from-source install, in one line

For a checkout at `~/rotorcc` with its remote set. Copy-pasteable, and it stops
at the first failure rather than half-upgrading:

```bash
cd ~/rotorcc && git diff --quiet && git diff --cached --quiet && git pull --ff-only && pnpm install --frozen-lockfile && pnpm build && rotorcc doctor || { echo "!! rotorcc update FAILED or the tree is dirty — nothing further was applied" >&2; false; }
```

That is the bootstrap. Once it has run once, `rotorcc upgrade` does all of the
above with the refusals, the staged build and the verification.

## What it does, in three layers

**Continuous durability.** Hooks on `Stop`, `SubagentStop`, `PreCompact` and
`SessionEnd` copy every session transcript into a git repository rotorcc owns,
and save every watched worktree's uncommitted work. Transcripts are append-only,
so after the first snapshot each one costs a few kilobytes. The heavy half runs
in a detached process, so a hook never makes you wait on a git push.

**A checkpoint is recoverable, not authoritative.** It never becomes a commit on
your branch. rotorcc writes a commit object from the working tree using a
temporary index — your index, your files and your branch are untouched — and
records it at `refs/rotorcc/checkpoints/<branch>`. That is not a branch, does
not show up in `git branch`, is never pushed, and CI never sees it. Get the work
back with:

```bash
git checkout refs/rotorcc/checkpoints/<branch> -- .
```

The only thing rotorcc pushes is commits **you** made and had not pushed yet.
This is the direct consequence of three incidents on 2026-08-19 in which the old
"commit everything dirty and push it" sweep committed a stale tree over newer
work, silently reverted a branch, and published an agent's half-finished change
— source without its tests — as a branch tip.

**Rotation happens under the running session.** A Claude Code session reads its
credential from disk on **every request**, not once at launch — measured on
2026-08-19 against v2.1.235, not assumed. So rotorcc changes the credential in
place and the session carries on: no successor, no new pane, no cold start, no
lost context, and no way to end up with two agents on one worktree. It verifies
the swap took rather than assuming it did, and it falls back to the older
replace-the-session path on evidence that it did not. See
[ADR 0003](docs/adr/0003-live-credential-hot-swap.md) for the experiment and for
why the fallback is not deprecated: hot-swap is undocumented behaviour of a
client nobody here controls, and a tool whose rotation breaks silently on the
day that changes is the failure this one exists to prevent.

`rotation.mode` is `auto` (hot-swap, verify, fall back), `hotswap` (never
replace a session) or `successor` (always replace one).

**The weekly window is what matters.** The 5-hour window refills several times a
day; the 7-day one is the budget you actually regret spending early. So the
weekly window drives the decision, and a spent 5-hour window with a healthy week
makes rotorcc checkpoint and _wait_ rather than burn another account's week to
escape something that comes back in three hours.

**When every account is spent, it stops.** No rotation onto an exhausted
account, no successor with nowhere to go, and nothing queued for later. It saves
everything, prints a notice naming each account with its headroom and reset
time, and waits for you.

**Rotation that knows about work in flight.** This is the part a plain account
switcher cannot do. Before rotating, rotorcc looks at what is actually running:

- If a tree holds work it **cannot** save — a protected branch, a tree mid-rebase,
  a branch with no remote — it **refuses to rotate** and checkpoints instead.
  Rotating ends the session that owns that work.
- If the best available account does not have enough headroom to **finish** what
  is running, it refuses rather than moving you onto an account that dies in
  twenty minutes and costs a second cold start. It estimates from observed burn
  rate, and when there is not enough history to estimate, it says that plainly
  instead of pretending the choice was sized.

Set `refuseRotationWithUnsavedWork: false` to get plain switcher behaviour. That
is a choice, and not the default.

**Reconstruction.** If the process is killed anyway — a hard limit, an OOM, a
closed laptop — the next `SessionStart` finds an unclean exit, rescues whatever
is uncommitted, and hands the new session the resume plan as its first context.

If your environment does not permit switching accounts automatically, set
`rotation.enabled` to `false`. Layers one and three are the ones that actually
prevent loss, and they keep working: rotorcc still watches headroom, still warns,
still checkpoints everything at the soft threshold, still writes the manifest at
the rotate threshold and tells your agent to wrap up. It just leaves the switch
to you.

## What it cannot do

Read this part. A backup tool that oversells itself is worse than none.

- **In-flight reasoning is unrecoverable.** Between the moment a model produces
  a tool call and the moment the result comes back, there is state in a running
  process that is not on disk anywhere. No tool can save it — not this one, not
  any other. rotorcc makes the window one tool call wide. It does not close it.
- **A hot swap cannot be fully verified from outside.** rotorcc can prove the
  credential and the identity block on disk are the target's, and it can watch
  the live session for an authentication failure. It cannot read another
  process's memory. So a session that made no request during the watch is
  reported as `unobserved`, not as `verified`, and `auto` falls back only on
  evidence of failure — never on the absence of evidence of success, because
  falling back means replacing a session that is very probably fine.
- **Hot-swap depends on undocumented client behaviour.** It works today and it
  was measured rather than assumed. It could stop working in any Claude Code
  release with no announcement. That is exactly why the successor path is kept
  fully working; if hot-swap stops, set `rotation.mode` to `successor` and
  rotation keeps happening the old way.
- **It cannot resume a conversation that was never saved.** `--continue` needs a
  prior session in that directory. rotorcc detects when there is not one and says
  so instead of pretending the successor started clean.
- **It will not answer the workspace trust dialog for you.** A directory the CLI
  has not been trusted in stops the successor at a prompt. rotorcc detects that
  and logs it. Trusting a directory is your decision.
- **It never force-pushes and never touches a protected branch.** If your work
  is on `main`, or the remote has diverged, rotorcc reports it and leaves it.
  That is a deliberate refusal, not a gap.
- **Windows is best-effort.** Every code path is the same, but Task Scheduler
  works in whole minutes, and there is no tmux, so successor launch is manual
  unless you run under WSL. `rotorcc doctor` tells you which of these apply.
- **Predictions are extrapolations of a bursty process.** The burn rate is a
  least-squares fit over recent headroom samples. Real agent usage arrives in
  bursts, so the error bars are wide and rotorcc says so: every prediction
  carries its confidence, its sample count and the span they cover, and
  confidence never reads `high` without roughly an hour of well-fitted data.
  When there is not enough history it reports `unknown` rather than a number.
- **It cannot tell how much work is left.** "Will the running work finish first"
  is answered from burn rate and elapsed session time only. An agent does not
  know how long its own task will take either. Treat it as a smoke alarm, not a
  schedule.
- **It cannot rescue an account whose refresh token has died.** If Anthropic
  rejects the grant, that login needs `claude /login` again. rotorcc detects it
  and says which account, but it cannot re-authenticate on your behalf.
- **The quota endpoint has a budget.** Poll it too hard — several tools on one
  machine, or several machines on one account — and it returns 429. rotorcc has
  a three-minute poll floor per account and honours the server's `Retry-After`,
  but if the budget is already gone it will report `unknown` for that account
  until it comes back. That is the honest answer, and it means one fewer
  rotation target until it clears.

## Commands

### Watching

|                         |                                                       |
| ----------------------- | ----------------------------------------------------- |
| `rotorcc tui` / `watch` | the live dashboard above, with keys                   |
| `rotorcc tui --once`    | one frame and exit — cron-friendly, pipes cleanly     |
| `rotorcc status`        | the same facts, printed once                          |
| `rotorcc predict`       | when the active account runs out, with the confidence |

### Driving it from the dashboard

|                |                                                        |
| -------------- | ------------------------------------------------------ |
| `↑↓` / `j` `k` | move between accounts                                  |
| `enter` / `s`  | switch to the selected account now                     |
| `b`            | rotate to the best target now, by the current strategy |
| `d`            | disable / enable the selected account                  |
| `t`            | change the rotation strategy                           |
| `f`            | force a quota re-poll, ignoring the poll floor         |
| `r`            | refresh the screen without spending a quota request    |
| `w`            | why has nothing happened — and act on it from there    |
| `o`            | the last action's full output                          |
| `p` `?` `q`    | pause · keys · quit                                    |

Every acting key runs **the same code as the matching command**: `enter` is
`rotorcc switch`, `d` is `rotorcc accounts disable`, `t` is `rotorcc config set
strategy`, and `w` → `c` is `rotorcc push-unpushed`. There is one implementation
of each and one set of tests for it — a dashboard with its own switch has two
switch implementations, and the one nobody tests is the one that runs at three
in the morning. See [ADR 0004](docs/adr/0004-the-dashboard-is-a-control-surface.md).

Each of them asks before acting, with the target's spend on both windows in the
question, and shows the result in the pane. Only one runs at a time, by whatever
route the key arrived, and each takes rotorcc's own tick lock first so it cannot
race the every-minute watcher — a lock a live watcher holds is waited for, never
broken. `q` during an action leaves once it finishes rather than exiting
part-way through a credential switch; press it again to leave anyway.

`--once`, and any run whose stdout is not a terminal, render one **read-only**
frame: no cursor, no keys. Handing a control surface to something that cannot
answer a confirmation is worse than handing it nothing.

The `w` panel answers the question a dashboard usually cannot. It shows the last
decision that did not act, in the words the decision function used; what the
selector says about every account right now, taken from the same `selectTarget`
the watcher calls rather than reconstructed afterwards; and any raised flag with
its reason. From inside it, `c` checkpoints everything, `x` clears the raised
flags, and `f` re-polls.

### Accounts

|                                    |                                                       |
| ---------------------------------- | ----------------------------------------------------- |
| `rotorcc accounts`                 | every managed account with its binding window         |
| `rotorcc accounts --token-status`  | which store each credential came from, and its expiry |
| `rotorcc accounts unclaimed`       | stored credentials no account in the roster claims    |
| `rotorcc accounts add`             | capture the login Claude Code is using right now      |
| `rotorcc accounts add-token -`     | register a setup token or API key, read from stdin    |
| `rotorcc accounts remove <ref>`    | forget an account and its stored credential           |
| `rotorcc accounts alias <ref> <n>` | give it a short name (`--unset` to clear)             |
| `rotorcc accounts disable <ref>`   | hold it out of automatic rotation                     |
| `rotorcc accounts enable <ref>`    | put it back                                           |
| `rotorcc accounts swap <a> <b>`    | exchange two slots, credentials and all               |
| `rotorcc accounts move <ref> <n>`  | put an account in a specific slot                     |
| `rotorcc accounts import`          | one-off migration (`--from-cswap`)                    |
| `rotorcc accounts export <path>`   | a portable copy — **contains real credentials**       |
| `rotorcc switch [ref]`             | change account now; no ref means pick by strategy     |
| `rotorcc run <ref> -- <cmd>`       | run as an account, this terminal only                 |
| `rotorcc map [ref] [path]`         | bind a directory to an account; bare form lists them  |
| `rotorcc unmap [path]`             | remove a binding                                      |

`<ref>` is a slot number, an email, or an alias.

### Everything else

|                                  |                                                       |
| -------------------------------- | ----------------------------------------------------- |
| `rotorcc init`                   | detect this machine, write `config.json`              |
| `rotorcc install-hooks <path>`   | merge rotorcc's hooks into a project's settings       |
| `rotorcc uninstall-hooks <path>` | take them out again                                   |
| `rotorcc install-scheduler`      | run the tick every minute                             |
| `rotorcc daemon [--once]`        | the tick itself, or a foreground loop                 |
| `rotorcc snapshot`               | copy transcripts into the store now                   |
| `rotorcc push-unpushed`          | commit and push every watched worktree now            |
| `rotorcc manifest`               | write a resume manifest now                           |
| `rotorcc resume`                 | print the plan from the last manifest                 |
| `rotorcc config [set K V]`       | read or change one setting, revalidated               |
| `rotorcc doctor`                 | check everything, and say which assumptions are false |
| `rotorcc upgrade [--check]`      | update rotorcc itself, then prove the new build runs  |
| `rotorcc purge --yes`            | delete every file rotorcc owns, listed first          |

### Recovering an orphaned credential

A switch stashes the account it is leaving before it activates the one it is
going to, so a crash in the wrong millisecond can leave a real login at a slot
nothing points at any more. Nothing else surfaces those.

```bash
rotorcc accounts unclaimed                       # what is there, and why
rotorcc accounts unclaimed --purge <id> --yes    # delete exactly one
```

Purge takes one exact id. There is no bulk form and there will not be one: an
id that matches nothing is an error, because "it deleted something, just not
that" is worse than doing nothing. On macOS this scans the credential **files**
only — a stash held in the Keychain cannot be listed without a prompt, and the
command says so rather than implying it looked everywhere.

### Uninstalling

```bash
rotorcc purge          # lists every path it would delete, and deletes nothing
rotorcc purge --yes    # actually does it
```

It enumerates first, with sizes and with what is irreversible marked as such,
and it never touches Claude Code's own credential, config or home — those are
listed under "NOT touched" so the promise is checkable rather than merely
stated. Hooks inside a project's `settings.json` and the scheduler unit are
edits to files rotorcc does not own, so it names them and gives you the command
instead of reaching in.

Export first if any of those logins are your only copy:
`rotorcc accounts export ~/rotorcc-accounts.json --yes`.

### Exit codes for `daemon --once`

For a cron line that needs to branch on what happened:

| code |                                                                     |
| ---- | ------------------------------------------------------------------- |
| `0`  | nothing to do — headroom is fine and rotorcc changed nothing        |
| `1`  | acted — warned, checkpointed, queued a handover, or switched        |
| `2`  | would act, but could not — refused, blocked, exhausted, lock held   |
| `3`  | error — the tick could not complete, or an action it started failed |

Precedence is error, then blocked, then acted, then nothing: a tick that
checkpointed **and** refused to rotate is a `2`, because the refusal is the part
a human has to decide about. A tick that could not run because another rotorcc
operation held the lock is also a `2` and never a `0` — it did not look, so it
is in no position to say there was nothing to see. Under `--dry-run` the code
reports what rotorcc _would_ have done; nothing is written on that path.

`--json` carries the same number as `exitCode`, so nothing has to re-derive it.

### Flags

`--json` on every read command. `--dry-run` on every command that writes.
`--strategy work-aware|best|next-available|consume-first`, `--model NAMES`,
`--theme auto|dark|light|none`, `--force` to re-poll quota inside the poll floor.

**A dry run cannot affect a live session.** It writes no flag an agent would
obey, and its manifest goes to `manifests/dry-run/` where no resume path reads
it, with a banner across the top. Both of those were production defects
(2026-08-18) before they were rules.

### Rotation strategies

| strategy         |                                                                                                       |
| ---------------- | ----------------------------------------------------------------------------------------------------- |
| `work-aware`     | **default.** Prefer a target with enough headroom to _finish_ the running work; refuse if none has it |
| `best`           | most headroom wins                                                                                    |
| `next-available` | next slot in order, skipping exhausted — predictable, spreads use                                     |
| `consume-first`  | soonest-resetting window first, to spend quota about to expire                                        |

Every strategy refuses an account whose headroom is **unknown**, and refuses one
the operator disabled unless it was named explicitly.

## Configuration

`rotorcc init` writes `config.json` to your platform's config directory
(`~/.config/rotorcc/` on Linux and macOS, `%APPDATA%\rotorcc\` on Windows). The
settings you are most likely to change:

```jsonc
{
  "projects": [
    {
      "path": "/home/dev/code/my-project",
      "worktreeGlobs": [".claude/worktrees/*"], // which trees to checkpoint
      "checkpointGlobs": ["**/checkpoint-*.md"], // resume notes to collect
      "protectedBranches": ["main", "master"], // never committed to
    },
  ],

  // Percentages are HEADROOM LEFT, not usage. "rotatePct: 5" means
  // "act when 5% of the binding window remains".
  "thresholds": { "warnPct": 15, "softPct": 10, "rotatePct": 5 },

  // The WEEKLY handover point, and the one that actually decides whether to
  // change accounts. 5 means "hand over when 5% of the week is left" (95%
  // utilised). The 5-hour window never triggers a handover on its own.
  "weeklyRotatePct": 5,
  "weeklyWarnPct": 20, // warn, do not act
  "minTargetHeadroomPct": 20, // refuse to rotate onto an account this low
  "cooldownSeconds": 900, // no second rotation inside this
  "hysteresisPct": 5, // how far headroom must recover to re-arm
  "pollSeconds": 60,
  // Per-model weekly windows to count. EMPTY COUNTS THEM ALL, which is the
  // safe default: a model capped at 100% blocks that model's work even with
  // 5h/7d headroom to spare, and quietly ignoring it is how a session dies at
  // "93% remaining".
  "models": ["Fable"],

  // How a rotation target is chosen. work-aware prefers one with enough
  // headroom to FINISH what is running, and refuses if none has it.
  "strategy": "work-aware",
  // Refuse to rotate while work sits somewhere rotorcc cannot save it — a
  // protected branch, a tree mid-rebase, a branch with no remote. Off makes
  // rotorcc behave like a plain switcher, which is a choice, not a default.
  "refuseRotationWithUnsavedWork": true,

  "storePath": "/home/dev/.local/share/rotorcc/store",
  // Where managed accounts live. Empty means the platform default. It holds
  // credentials: 0700, files 0600. Do not point it at a synced folder.
  "accountsDir": "",
  "mirror": { "type": "rsync-ssh", "target": "user@host:/srv/transcripts/" },

  "successor": {
    "launcher": "tmux",
    "command": ["claude", "--continue", "{{prompt}}"],
    "resumePrompt": "rotorcc resume: read {{manifestMarkdown}} and continue every lane…",
  },

  "secretsScreen": { "enabled": true, "onHit": "mirror-only", "extraPatterns": [] },
  "retire": { "killOldWindow": false, "quiesceSeconds": 180 },

  // The master switch for switching accounts. Turn it off and rotorcc becomes
  // a pure durability tool: it still watches, warns, checkpoints and recovers a
  // crashed session, and it never switches. Whether a machine may change
  // accounts by itself is a policy question, and it deserves one explicit
  // boolean rather than being inferred from a threshold set to zero.
  "rotation": { "enabled": true },
}
```

`rotorcc config validate` checks it. `rotorcc config set thresholds.rotatePct 3`
changes one value and revalidates before saving, so a typo is rejected rather
than stored.

## Deliberately not built

Stated here rather than left as an implied gap, because "we did not get to it"
and "we decided against it" look identical from outside and only one of them is
a plan.

- **A macOS menubar app.** rotorcc is a terminal tool for people who live in a
  terminal. A menubar surface would be a second UI to keep truthful, on the one
  platform where the credential store has a backend the maintainers cannot
  exercise, for an audience that already has `rotorcc tui` in a pane. If you
  want an always-visible indicator, `rotorcc status --json` is one line of
  shell away from anything that renders JSON.
- **Windows Credential Manager.** Credentials on Windows are stored as `0600`
  files under `%LOCALAPPDATA%`, the same as everywhere else. Moving them into
  Credential Manager would be better, and it is not being written blind: the
  maintainers have no Windows machine to verify it on, and a credential backend
  that has never actually been exercised is worse than a simple one that has.
  `rotorcc doctor` names the platform so nobody has to guess which applies.
- **Enumerating Keychain-held credentials on macOS.** `security` has no listing
  that works without a prompt, so `rotorcc accounts unclaimed` scans the
  credential files and says out loud that it did not scan the Keychain, rather
  than reporting a clean store it did not fully inspect.

The macOS Keychain path itself is written, used, and **verified rather than
trusted**: every write is read back and compared, and a mismatch throws so the
caller falls to the file backend deliberately and with a reason instead of
accidentally and without one. That check cannot be exercised on the maintainers'
machines, which is precisely why it is a check.

## What the numbers mean

**rotorcc reports what has been USED, with the window named.** `82% used (5h)`,
not `18% left`. Anthropic's API reports utilisation and so does Claude Code's
status line, so reporting headroom made you invert one screen in your head while
comparing two — and a bare percentage is worse: `99% (5h)` returns within the
hour and `99% (7d)` does not, and printing `99%` cannot tell you which you are
looking at. Both of those caused a reporting error here before the convention
changed.

**Both windows are always shown, never just the one that binds.** An account at
99% on its five-hour window and 72% on its week is unusable for forty minutes
and healthy after that; an account at 99% on its week is finished until Sunday.
One number cannot tell those apart, and rotorcc reported the first as the second
before this rule existed. Which window binds is still marked — it is the one
that will stop the work first — but it is never the only thing on screen.

An account rotorcc could not measure has **no bar and no number, on either
window**, on every screen, with the reason beside it. There is no fallback
value: under a "used" convention the tempting `?? 0` renders an unmeasured
account as completely fresh, which would make the one account rotorcc cannot
see the most attractive rotation target on the screen.

In `--json`, each account carries `usedPct`, `headroomPct`, `bindingWindow` and
a `windows` array that **always contains `5h` and `7d`**, each with its own
`usedPct`, `resetsAt` and a `binding` flag. `headroomPct` keeps its original
meaning: inverting a field while keeping its name would make an existing reader
see `99` and conclude "healthy" when it means "nearly gone". Everything that was
not measured is `null` — never `0`, never `100`.

## Privacy and safety

- rotorcc stores and reads credentials — see [Credentials,
  honestly](#credentials-honestly) above for exactly how, and where. It
  transmits them to nowhere except Anthropic's own token and usage endpoints,
  which is what authenticating to them means.
- Every snapshot's new bytes are screened for credential shapes — private keys,
  cloud access keys, provider tokens, JWTs, credential-shaped assignments — and
  the screen runs on the source, before anything is written. What a hit does is
  yours to choose (`secretsScreen.onHit`):

  |                         |                                                         |
  | ----------------------- | ------------------------------------------------------- |
  | `mirror-only` (default) | copy locally, refuse the off-machine mirror, log loudly |
  | `skip-file`             | that transcript never enters the store at all           |
  | `fail-closed`           | abandon the whole snapshot                              |

  The default is `mirror-only` because those bytes are already at rest on that
  disk, and declining to back them up protects nothing while leaving the session
  unrecoverable. Choose `skip-file` when the store outlives or is read more
  widely than the transcripts — a git store keeps history the originals may not,
  and git history is hard to purge.

- Log output is redacted with the same patterns.
- No telemetry. The only network calls are the two Anthropic endpoints listed
  above and your own mirror target.

## What rotorcc owns

Everything about accounts, natively. No other switcher needs to be installed.

| owned natively                                                                       |
| ------------------------------------------------------------------------------------ |
| Credential storage — macOS Keychain, `~/.claude/.credentials.json`, `~/.claude.json` |
| The switch itself, as a five-step transaction with rollback                          |
| Quota reading, straight from Anthropic, with a cache and a poll floor                |
| Token refresh, with a one-time-token discipline (see below)                          |
| The roster: slots, aliases, disable/enable, swap/move                                |
| Strategy selection, including work-aware                                             |
| Directory → account mappings, and `run` for a single terminal                        |

**The one thing that is not owned** is the migration path. `rotorcc accounts
import --from-cswap` reads another switcher's store **once**, read-only, so
nobody has to re-authenticate three accounts by hand. After that it is never
read again and the source is never modified.

There is also a fallback: if rotorcc manages **no accounts of its own** and a
`cswap` binary is configured, it will use it rather than reporting nothing —
and every message on that path says so explicitly, so you never have to guess
which source produced a number. `rotorcc doctor` treats that state as a
**failure** with the import as its fix, not as a working configuration.

Why native rather than composing: [ADR 0001](docs/adr/0001-own-the-account-layer.md).

## Credentials, honestly

rotorcc now handles your logins. That is a serious thing to do and you should
know how.

- Stored under `~/.local/share/rotorcc/accounts/` (`%LOCALAPPDATA%\rotorcc\accounts`
  on Windows), directories `0700` and files `0600`. The mode is set on the file
  descriptor **before** any secret is written into it, not chmod'd afterwards.
- Every write is atomic — temp file, then rename — so a crash cannot leave a
  half-written credential that reads as "this account has no login".
- On macOS the Keychain is used when it answers, files when it does not.
- Stored base64-encoded. That is **encoding, not encryption**; the file mode is
  what protects it. It is worth doing only because it stops a credential being
  matched by a careless `grep -r sk-ant` and pasted into a bug report.
- rotorcc holds **Claude Code's own** credential and config locks while it
  swaps, in Claude Code's own order. Without that, a switch landing inside
  Claude Code's token refresh gets overwritten by the refreshed _old_ account's
  token, and the backup you just took holds a refresh token that is already
  spent.
- A refresh token is **one-time**. If rotorcc reads a credential from a backend
  that might lag the real one, it **refuses to refresh it** rather than spending
  a token that may already be dead — which would produce `invalid_grant` and
  look exactly like an account that needs a re-login.
- One previous generation of each credential is retained as a recovery cushion.
- A token is never logged, never put in an error message, never passed as a
  command-line argument, and never written to the decision journal. The
  `Secret` type makes logging one a compile error.

`rotorcc accounts export` is the one command that moves credential bytes into a
file you choose. It refuses without `--yes` and tells you twice what is in it.

## Network calls

rotorcc makes exactly two, both to Anthropic, both authenticated with your own
credential, both in `src/accounts/oauth.ts` so the claim is checkable by reading
one file:

|                                                   |                                 |
| ------------------------------------------------- | ------------------------------- |
| `GET https://api.anthropic.com/api/oauth/usage`   | your quota windows              |
| `POST https://platform.claude.com/v1/oauth/token` | refresh an expired access token |

Plus your own `mirror.target`, if you configured one.

**No telemetry, no analytics, no update check, no third-party host.** rotorcc is
not an Anthropic product and is not affiliated with or endorsed by Anthropic.

## Contributing

```bash
npm install
npm run typecheck
npm test
npm run build
npm run leak-audit
```

Publishing (maintainers): `npm login`, then `npm publish`. `prepublishOnly`
runs the leak audit, the typecheck, the whole suite and a fresh build first, so
a published tarball cannot contain a stale `dist/` or a failing tree. Check what
is going out with `npm pack --dry-run` before you do it — the `files` list is a
whitelist, and a package is a permanent public artefact.

Tests use real git repositories in temp directories, a temp Claude home, and an
injected `fetch`, so **no test reaches the network or touches a real
credential**, and the suite runs identically on all three platforms.

572 tests. The ones worth reading first are
`test/unknown-is-unknown.test.ts` — the one rule, walked across every surface
that could break it — `test/credentials-switch.test.ts`, which is about the ways
a switch could destroy a login rather than the way it works, and the last group
in `test/worktrees.test.ts`, which pins the invariant that stops the sweep
publishing a tree that is not a descendant of what it overwrites.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the design and the exact rotation
timeline, and [docs/adr/](docs/adr/) for the decisions and what they rejected:

- [ADR 0001](docs/adr/0001-own-the-account-layer.md) — why rotorcc owns its
  account layer instead of composing with a switcher.
- [ADR 0002](docs/adr/0002-handover-not-interruption.md) — why the weekly window
  is the signal that matters, and why an exhausted fleet stops rather than
  thrashing. Its central factual claim is superseded by 0003; its judgement is
  not.
- [ADR 0003](docs/adr/0003-live-credential-hot-swap.md) — the experiment showing
  a live session CAN be moved to another account, what that changed, and why the
  old mechanism is kept anyway.
- [ADR 0004](docs/adr/0004-the-dashboard-is-a-control-surface.md) — why the
  dashboard acts, and why every key it offers runs the CLI's own code rather
  than a second implementation of it.

## Licence and attribution

MIT.

rotorcc's account subsystem was built by studying
[claude-swap](https://github.com/realiti4/claude-swap) (MIT, Onur Cetinkol) —
Claude Code's credential paths, its two-lock refresh protocol, the
keychain-before-file read order, the OAuth/API-key mutual exclusion, and the
usage endpoint's shape. Those are load-bearing safety properties that are not
obvious, and the credit is owed. rotorcc is an independent TypeScript
implementation, not a port, and claims no affiliation with that project. Full
notice: [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
