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

That is the whole setup. From then on:

```bash
rotorcc tui                     # the live dashboard
rotorcc status                  # the same facts, printed once
```

```
rotorcc 0.1.0                                                            20:20:47

ACCOUNTS
    #1  work                       ░░░░░░░░░░░░░░░░   0% 5h      resets 19 Aug 20:30
    #2  spare                      ███████░░░░░░░░░  45% 7d      resets 24 Aug 09:00
  ▸ #3  personal                   unknown                  quota read failed: http-429
  thresholds: warn 15% · soft 10% · rotate 5%

PREDICTION
  reaches 5% headroom in 2.3h
  18.4 points/hour · medium confidence · least-squares fit over 14 samples
  spanning 41 minutes (R²=0.79)
  work finishes first? likely no — 45% left is under the estimated 62% needed

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
  20:19 refused       12%     unsaved work on a protected branch; checkpointed instead
  20:18 checkpointed  14%     headroom 14.2% on 5h; soft checkpoint requested
  20:17 idle          16%     headroom 16.1% on 5h; nothing to do
```

Note account #1: an **empty bar at 0%** — a real measurement of a spent window.
Account #3 has **no bar at all**, because an empty bar and a genuine 0% look
identical and only one of them is a measurement.

## What it does, in three layers

**Continuous durability.** Hooks on `Stop`, `SubagentStop`, `PreCompact` and
`SessionEnd` copy every session transcript into a git repository rotorcc owns,
then commit and push every watched worktree. Transcripts are append-only, so
after the first snapshot each one costs a few kilobytes. The heavy half runs in
a detached process, so a hook never makes you wait on a git push.

**Rotation as a handover, not an interruption.** A Claude Code process reads its
credential once, when it launches — there is no way to change a live session's
account. So rotorcc does not try. When the weekly window runs low it records
which account the **next** session should open on, and the `SessionStart` hook
switches before that session begins. Your running work is never interrupted and
no second process is ever spawned.

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
- **A credential switch only takes effect at process start.** The CLI reads its
  credentials once, when it launches. There is no such thing as rotating a live
  session, and rotorcc does not pretend otherwise: it changes the account the
  **next** session opens on. The consequence is that a session which runs for
  another six hours runs those hours on the old account. That is the correct
  trade — the alternative is killing it — but it is why the weekly threshold
  fires early, and why `rotorcc tui` shows you a queued handover before it
  happens.
- **A handover is not immediate.** See above. If you want the new account now,
  end the session and start a new one, or run `rotorcc switch` yourself.
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
| `rotorcc tui` / `watch` | the live dashboard above                              |
| `rotorcc tui --once`    | one frame and exit — cron-friendly, pipes cleanly     |
| `rotorcc status`        | the same facts, printed once                          |
| `rotorcc predict`       | when the active account runs out, with the confidence |

In the dashboard: `q` quit, `r` refresh now, `p` pause.

### Accounts

|                                    |                                                      |
| ---------------------------------- | ---------------------------------------------------- |
| `rotorcc accounts`                 | every managed account with its binding window        |
| `rotorcc accounts add`             | capture the login Claude Code is using right now     |
| `rotorcc accounts add-token -`     | register a setup token or API key, read from stdin   |
| `rotorcc accounts remove <ref>`    | forget an account and its stored credential          |
| `rotorcc accounts alias <ref> <n>` | give it a short name (`--unset` to clear)            |
| `rotorcc accounts disable <ref>`   | hold it out of automatic rotation                    |
| `rotorcc accounts enable <ref>`    | put it back                                          |
| `rotorcc accounts swap <a> <b>`    | exchange two slots, credentials and all              |
| `rotorcc accounts move <ref> <n>`  | put an account in a specific slot                    |
| `rotorcc accounts import`          | one-off migration (`--from-cswap`)                   |
| `rotorcc accounts export <path>`   | a portable copy — **contains real credentials**      |
| `rotorcc switch [ref]`             | change account now; no ref means pick by strategy    |
| `rotorcc run <ref> -- <cmd>`       | run as an account, this terminal only                |
| `rotorcc map [ref] [path]`         | bind a directory to an account; bare form lists them |
| `rotorcc unmap [path]`             | remove a binding                                     |

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
```

Tests use real git repositories in temp directories, a temp Claude home, and an
injected `fetch`, so **no test reaches the network or touches a real
credential**, and the suite runs identically on all three platforms.

400 tests. The ones worth reading first are
`test/unknown-is-unknown.test.ts` — the one rule, walked across every surface
that could break it — and `test/credentials-switch.test.ts`, which is about the
ways a switch could destroy a login rather than the way it works.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the design and the exact rotation
timeline, and [docs/adr/](docs/adr/) for the decisions and what they rejected:

- [ADR 0001](docs/adr/0001-own-the-account-layer.md) — why rotorcc owns its
  account layer instead of composing with a switcher.
- [ADR 0002](docs/adr/0002-handover-not-interruption.md) — why rotation is a
  handover to the next session rather than an interruption of this one, and why
  the weekly window is the signal that matters.

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
