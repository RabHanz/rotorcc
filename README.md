# rotorcc

Long agent sessions end badly in two ways. You hit a rate limit mid-tool-call
and the process dies with an hour of uncommitted work in six worktrees. Or you
switch accounts to keep going, and the switch takes effect only in a _new_
process — so the running one dies anyway, at a moment nobody chose.

rotorcc watches your account headroom, checkpoints continuously so the loss
window is one tool call, and when the window is nearly gone it writes a resume
plan, switches accounts and starts the replacement session pointed at that plan.

It is a CLI for Claude Code power users who run several accounts and leave
agents running for hours. Node ≥ 20, no native dependencies, Linux, macOS and
Windows.

## 60-second quickstart

```bash
npm install -g rotorcc

rotorcc init                    # detects ~/.claude, your switcher, your project
rotorcc install-hooks ~/code/my-project
rotorcc install-scheduler       # a one-minute tick: systemd, launchd or Task Scheduler
rotorcc doctor                  # confirms every assumption it makes
```

That is the whole setup. From then on:

```bash
rotorcc status                  # headroom, last backup, work that exists nowhere else
```

```
rotorcc

  > 1  work-account                 ################.... 80% left (5h) · resets 2026-08-18 05:09
    2  spare-account                #################### 97% left (7d)

  level        ok   (warn 15% · soft 10% · rotate 5%)

  store        /home/dev/.local/share/rotorcc/store
               8f3a1c2 snapshot: hook:Stop (2m ago)
  snapshot     2m ago
  manifest     none written
  watcher      Tue 05:18:12 UTC 34s left rotorcc.timer rotorcc.service

  unsaved      1 tree(s) hold work that is not on a remote:
               work/parser  +2 unpushed, 4 dirty  /home/dev/code/my-project/.claude/worktrees/agent-1
```

## What it does, in three layers

**Continuous durability.** Hooks on `Stop`, `SubagentStop`, `PreCompact` and
`SessionEnd` copy every session transcript into a git repository rotorcc owns,
then commit and push every watched worktree. Transcripts are append-only, so
after the first snapshot each one costs a few kilobytes. The heavy half runs in
a detached process, so a hook never makes you wait on a git push.

**Predictive rotation.** A one-minute tick reads live per-account usage and
converts it to headroom. At 15% left it warns. At 10% it checkpoints everything
and raises a flag your agent sees on its next turn: _commit, push, write your
resume note now_. At 5% it writes the resume manifest, switches accounts and
opens the replacement session with a prompt telling it to read the manifest.

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
  credentials once, when it launches. So there is no such thing as rotating a
  live session. What rotorcc actually does is checkpoint, stop, switch, resume —
  made tight enough that the seam is a few seconds instead of an hour.
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

## Commands

|                                  |                                                 |
| -------------------------------- | ----------------------------------------------- |
| `rotorcc init`                   | detect this machine, write `config.json`        |
| `rotorcc install-hooks <path>`   | merge rotorcc's hooks into a project's settings |
| `rotorcc uninstall-hooks <path>` | take them out again                             |
| `rotorcc install-scheduler`      | run the tick every minute                       |
| `rotorcc daemon [--once]`        | the tick itself, or a foreground loop           |
| `rotorcc snapshot`               | copy transcripts into the store now             |
| `rotorcc push-unpushed`          | commit and push every watched worktree now      |
| `rotorcc manifest`               | write a resume manifest now                     |
| `rotorcc status`                 | the screen above                                |
| `rotorcc resume`                 | print the plan from the last manifest           |
| `rotorcc config [set K V]`       | read or change one setting, revalidated         |
| `rotorcc doctor`                 | check everything                                |

Add `--dry-run` to any of them. It evaluates and reports and changes nothing:
no commit, no push, no mirror, no account switch.

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
  // "rotate when 5% of the binding window remains".
  "thresholds": { "warnPct": 15, "softPct": 10, "rotatePct": 5 },
  "minTargetHeadroomPct": 20, // refuse to rotate onto an account this low
  "cooldownSeconds": 900, // no second rotation inside this
  "hysteresisPct": 5, // how far headroom must recover to re-arm
  "pollSeconds": 60,
  "models": ["Fable"], // per-model weekly windows to count too

  "storePath": "/home/dev/.local/share/rotorcc/store",
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

- rotorcc never reads, copies or transmits credential files. It reads the
  account switcher's usage output, and nothing else about your accounts.
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
- No telemetry. No network calls except your own mirror target and whatever the
  account switcher does.

## How it fits with an account switcher

rotorcc does not manage credentials. It reads usage from and delegates switching
to a separate account switcher — by default the `cswap` CLI, which reports
per-account 5-hour, 7-day and per-model windows as JSON and can activate a
stored login. Point `commands.cswap` at any program with a compatible
`list --json` and `switch <n>` if you use something else.

Without a switcher, rotorcc still does the whole first layer: continuous
snapshots, continuous checkpointing, manifests, and crash recovery. It just
cannot rotate. `rotorcc doctor` says so rather than failing quietly.

## Contributing

```bash
npm install
npm run typecheck
npm test
npm run build
```

Tests use real git repositories in temp directories and fake the account
switcher with a small Node script, so the suite runs identically on all three
platforms. See [ARCHITECTURE.md](ARCHITECTURE.md) for the design and the exact
rotation timeline.

MIT licensed.
