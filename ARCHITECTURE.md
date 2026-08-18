# Architecture

## The problem, stated precisely

A Claude Code session holds three kinds of state.

1. **Transcripts** — already durable. The CLI writes every session and every
   subagent to JSONL on disk as it goes, and an account switch deletes none of
   it. This is worth saying because it is the thing people assume is at risk,
   and it is not.
2. **Work in the repository** — durable only when committed and pushed. Six
   agents in six worktrees with an hour of uncommitted edits is an hour that a
   killed process takes with it.
3. **Live process state** — the running conversation, the in-flight tool call,
   the registry of background tasks. This is not on disk anywhere, and cannot be.

So rotorcc is a backup-and-resume design, not a capture design. It cannot save
(3). It makes (2) continuously durable, keeps a second copy of (1), and writes
down enough about (3) — from the hook payloads, which do carry the task
registry — that a fresh session can reconstruct the plan without re-deriving it.

## Why it is shaped this way

**A pure decision core.** `src/core/decide.ts` is one function from
`(usage, config, state)` to `(actions, nextState)`. No clock, no disk, no
subprocess. Rotation is the part that must never misfire, and a pure function is
the part you can test exhaustively. Every threshold, latch, hysteresis band and
cooldown decision lives there and nowhere else.

**Percentages are headroom, not usage.** The switcher reports utilisation. The
conversion happens once, at the boundary in `usage.ts`. Everything downstream —
config, logs, status screen, manifest — speaks in "how much is left", because
that is how an operator thinks about it.

**Everything external is an argv array from config.** `commands.git`,
`commands.cswap`, `commands.tmux`, and so on. Nothing is run through a shell.
This keeps quoting bugs and injection out, and it is what lets the test suite
substitute a fake switcher on any platform.

**Hooks fail open, always.** A hook that can block the tool loop is worse than
no hook. Every failure path in `commands/hook.ts` exits 0 with a logged warning.
The synchronous half only reads small files; the transcript copy and the git
pushes are handed to a detached child that outlives the hook.

**A one-shot tick, not a resident daemon.** systemd, launchd and Task Scheduler
all restart a one-shot for free. None of them will restart a resident process
they did not notice dying — and on a laptop, "did not notice dying" is the
normal case. `rotorcc daemon` without `--once` still exists for platforms with
no scheduler.

## Naming

The tool is `rotorcc`: _rotor_ for the rotation of accounts and for the thing
that keeps a machine turning, _cc_ for the common shorthand of the CLI it works
alongside. The name deliberately contains neither "claude" nor "anthropic" —
those are Anthropic's trademarks and are not available for a third-party product
name. Describing what the tool works with, in prose, is ordinary nominative use
and is fine; putting it in the package, repository or binary name is not.

Checked free before adoption: npm (404), PyPI (404), GitHub repository search
(0 results), GitHub code search (0 results), no GitHub user or organisation of
that name, no notable web result.

## Module map

```
src/
  cli.ts                 argument parsing, command dispatch
  config/
    schema.ts            the zod contract; every default lives here
    load.ts              read, validate, expand paths, get/set one key
  core/
    paths.ts             per-platform config/state/data dirs; the project slug rule
    usage.ts             parse the switcher's output -> headroom per account
    decide.ts            PURE. thresholds, latches, hysteresis, cooldown, target
    daemon.ts            one tick: read, detect, decide, act. and the loop
    checkpoint.ts        the single operation everything funnels into
    snapshot.ts          incremental transcript copy, git store, mirror
    worktrees.ts         discovery, inspection, the commit/push safety rules
    manifest.ts          the resume contract: schema + the human rendering
    successor.ts         tmux/screen launch, readiness, retirement
    transcripts.ts       locate sessions, read tails, liveness
    secrets.ts           the credential-shape screen
    settingsMerge.ts     add/remove hook entries without clobbering
    scheduler.ts         systemd / launchd / Task Scheduler plans
    state.ts             atomic state writes, flags, manifests, locking
    hookPayload.ts       the hook contract, written against captured payloads
    log.ts               logging with redaction
    proc.ts              execFile with an argv array; Windows shim resolution
  commands/              one file per verb
```

## The hook contract

Captured from a live CLI with a probe hook rather than taken from docs. Fixtures
in `test/fixtures/hook-payloads/` are those captures with paths neutralised, and
the tests parse them.

Every event carries `session_id`, `transcript_path`, `cwd`, `hook_event_name`.
Beyond that:

| event              | adds                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------- |
| `SessionStart`     | `source` (`startup`, `resume`, `clear`, `compact`)                                    |
| `SessionEnd`       | `reason`                                                                              |
| `UserPromptSubmit` | `prompt`                                                                              |
| `PreToolUse`       | `tool_name`, `tool_input`, `tool_use_id`                                              |
| `PostToolUse`      | `tool_response`, `duration_ms`                                                        |
| `Stop`             | `stop_hook_active`, `last_assistant_message`, `background_tasks[]`, `session_crons[]` |
| `SubagentStop`     | `agent_id`, `agent_type`, `agent_transcript_path`, `background_tasks[]`               |
| `PreCompact`       | `trigger`, `custom_instructions`                                                      |
| `PostCompact`      | `trigger`, `compact_summary`                                                          |

`background_tasks[]` — `{id, type, status, description, agent_type}` — is the
live task registry, and it is the only place a process that is about to stop can
learn what was still running. rotorcc writes it to `last-tasks.json` on every
hook so a crash recovery can still read it, and copies it into the manifest.

**Output**, also verified live rather than assumed:

- `hookSpecificOutput.additionalContext` reaches the **model**, on
  `SessionStart`, `UserPromptSubmit` and `PostToolUse`.
- `systemMessage` is shown to the **operator** and does _not_ reach the model.

rotorcc emits both when it raises a flag: the agent needs the instruction, the
human needs to see that a rotation is under way.

## The rotation timeline

```
        watcher (one-minute tick)          live session               successor
             │                                  │
 t+0   read usage ──────────────────────────────┤
       headroom 14% -> warn latch
             │  log only                        │
             │                                  │
 t+n   headroom 9% -> soft latch                │
       ├── snapshot transcripts ────────────────┤   (transcripts are copied
       ├── commit + push every worktree ────────┤    incrementally; only new
       ├── write soft-checkpoint-<ts>.json      │    bytes cross the wire)
       └── raise SOFT_CHECKPOINT_REQUESTED      │
                                                │
             ╭─── next UserPromptSubmit ─────────┤
             │    hook reads the flag            │
             │    -> additionalContext to model  │
             │    -> systemMessage to operator   │
             ╰──────────────────────────────────>│  agents commit, push,
                                                 │  write their resume notes
                                                 │
 t+m   headroom 4% -> rotate latch               │
       ├── snapshot + commit + push (final)      │
       ├── write manifest-<ts>.json AND .md      │  ← before anything is switched.
       │     · session id, transcript path       │    if the switch fails, the
       │     · background_tasks[] still open     │    plan still exists.
       │     · every tree: branch, tip, ahead,   │
       │       dirty, push result, resume notes  │
       │     · every account + headroom + reset  │
       │     · open pull requests (optional)     │
       │     · configured extra command output   │
       │     · the exact next commands           │
       ├── raise ROTATE_NOW                      │
       │                                         │
       │        ╭─── next hook fires ────────────┤
       │        │   "finish this tool call,      │
       │        │    checkpoint every agent,     │
       │        │    stop dispatching, exit"     │
       │        ╰───────────────────────────────>│
       │                                         │
       ├── note the predecessor's terminal ──────┤
       ├── switch account (switcher CLI)         │
       └── launch successor ────────────────────────────────>  claude --continue
                                                 │             "read <manifest.md>
                                                 │              and continue every
                                                 │              lane from its
                                                 │              recorded next step"
                                                 │                   │
       wait for the predecessor's transcript      │                   │
       to stop growing (quiesceSeconds) ─────────>│                   │
       final snapshot                             │                   │
       close its window (opt-in) ────────────────>X                   │
                                                                      ▼
                                                              work continues
```

The predecessor is never killed mid-tool-call. The watcher raises a flag and
waits; the retirement step is opt-in (`retire.killOldWindow`, default off), it
waits for the transcript to go quiet, and it snapshots once more before closing
anything. If it cannot positively identify the predecessor's window, it leaves
it alone.

## The three guards

Automatic switching goes wrong in two ways, and both have a named defence.

- **Latch.** Each level fires once per quota window. Without it, a tick at 4.9%
  headroom writes a manifest every sixty seconds for four hours.
- **Hysteresis.** A latch clears only when headroom climbs `hysteresisPct` above
  the threshold, so a reading that flickers across the line does not re-arm it.
- **Cooldown.** No second rotation within `cooldownSeconds`, whatever the
  numbers say. A switch that did not take needs a human, not a retry loop.

And one refusal: if no other account has `minTargetHeadroomPct` left, rotorcc
does not rotate at all. It checkpoints, logs why, and stops. Hopping between
three exhausted accounts burns the session and loses the work.

A latch is keyed on the binding window's reset time, so a genuine window
rollover re-arms it. Switching accounts drops every latch, because the new
account has its own windows.

## Hard-kill detection

Two independent signals, either of which overrides the percentages:

- **Limit signature.** The CLI reports exhaustion as ordinary text in the
  transcript. rotorcc reads the tail and matches configured literal strings
  (`hardKill.transcriptSignatures`), both raw and with JSON escapes undone.
  Literal strings rather than regexes: the wording changes between releases, and
  patching a string in a config file should not require thinking about escaping.
- **Dead process.** The transcript has not been written for
  `hardKill.deadAfterSeconds` **and** no matching process is running. Both
  halves are required — an idle transcript on its own just means somebody went
  to make tea.

## The transcript store

A git repository rotorcc owns, holding a mirror of
`<claudeHome>/projects/<slug>/`. Git because append-only JSONL deltas compress
to almost nothing, history is free, and `git log` is a usable answer to "what
did this look like at 3am".

The copy is done in Node, not with rsync: rsync is not on Windows, and the local
half has to work everywhere. Files are compared on size and mtime, so an
unchanged 77 MB transcript costs one `stat`, not one copy.

The off-machine mirror is best-effort with a timeout, and never blocks a
checkpoint. `rsync-ssh` uses `--append-verify`, which for append-only files
sends only the new tail; the store's own `.git` is excluded, because pack files
are rewritten and copying those with `--append-verify` would corrupt the far
side. `git-remote` pushes the store repository instead.

## The secrets screen

Runs over the **delta** of each snapshot — for append-only files, the bytes past
the previous copy's length, with a small overlap so a credential straddling the
boundary is still seen whole. A hit refuses the **mirror** for that snapshot,
loudly, and never the local copy.

That asymmetry is deliberate. The local store is on the same disk the
transcripts are already on, so refusing to copy them there protects nothing.
Sending them somewhere new is a different decision.

Patterns aim at credential shapes that are unmistakable — PEM blocks, AWS key
ids, GitHub and Slack tokens, Google API keys, JWTs, `sk-`-prefixed provider
keys, and credential-shaped assignments with a real-looking value. Placeholders,
redactions and `changeme` are explicitly excluded. A screen that cries wolf gets
switched off, and a screen that is off protects nothing either.

## Cross-platform notes

|           | Linux                          | macOS         | Windows                         |
| --------- | ------------------------------ | ------------- | ------------------------------- |
| config    | `~/.config/rotorcc/`           | same          | `%APPDATA%\rotorcc\`            |
| state     | `~/.local/state/rotorcc/`      | same          | `%LOCALAPPDATA%\rotorcc\state\` |
| store     | `~/.local/share/rotorcc/store` | same          | `%LOCALAPPDATA%\rotorcc\store`  |
| scheduler | systemd user timer             | launchd agent | Task Scheduler                  |
| successor | tmux                           | tmux          | manual, or WSL                  |
| mirror    | rsync or git remote            | same          | git remote                      |
| liveness  | `ps -eo args=`                 | same          | `tasklist`                      |

macOS uses the XDG layout rather than `~/Library/Application Support` on
purpose: the store is a git repository people will want to `cd` into, and a path
with a space in it makes every shell example worse.

WSL reports as Linux and gets the full feature set, which is the recommended way
to run this on a Windows machine.

`execFile` cannot launch a `.cmd` shim, and npm-installed `git` and `gh` often
are one, so `proc.ts` resolves bare command names against `PATH` on Windows
before spawning. The argv array survives intact instead of being re-quoted by
`cmd.exe`.

## Testing

- `decide.test.ts` — every threshold crossing, latch, hysteresis case, cooldown,
  and the refusal to thrash.
- `usage.test.ts` — both switcher output shapes, against captured fixtures,
  including the case where the account-wide window is fine and a per-model one
  is not.
- `hookPayload.test.ts` — the captured payloads for all nine events, plus the
  output contract.
- `settingsMerge.test.ts` — install, uninstall, idempotency, and that a
  lookalike hook without the sentinel is never removed.
- `secrets.test.ts` — thirteen positives and fifteen negatives.
- `worktrees.test.ts` — real git: protected branch, detached HEAD, conflicted
  merge, no remote, diverged remote, dry run.
- `manifest.test.ts` — schema round-trip and the rendered handover.
- `scheduler.test.ts` — the generated unit for each platform.
- `e2e.test.ts` — a fake switcher and a real project through a real tick: ok,
  soft, rotate, refusal, hard kill, dry run, latch, mirror refusal, broken
  switcher, lock contention.
