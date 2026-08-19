/**
 * The rotorcc configuration contract.
 *
 * Two conventions worth knowing before reading the fields:
 *
 *  1. Every percentage in `thresholds` is HEADROOM REMAINING, not utilisation.
 *     "rotate at 5" means "rotate when 5% of the window is left". The usage
 *     source reports utilisation; rotorcc converts once, at the boundary, so
 *     that the numbers an operator sets read the way an operator thinks.
 *
 *  2. Every external program is a configurable argv array, never a string run
 *     through a shell. That keeps quoting bugs out, keeps injection out, and
 *     lets the test suite substitute a fake binary on any platform.
 */
import { z } from 'zod';

const pct = z.number().min(0).max(100);

export const commandSchema = z.array(z.string().min(1)).min(1);

export const projectSchema = z.object({
  /** Absolute path to the repository root Claude Code is run in. */
  path: z.string().min(1),
  /**
   * Which git worktrees under this project rotorcc is allowed to checkpoint.
   * Matched against the worktree path relative to `path`, with `*` matching a
   * single segment and `**` matching any number.
   */
  worktreeGlobs: z.array(z.string()).default(['.claude/worktrees/*']),
  /** Resume notes to collect into the manifest, relative to each tree root. */
  checkpointGlobs: z.array(z.string()).default([]),
  /** Branches rotorcc will never commit to or push. */
  protectedBranches: z.array(z.string()).default(['main', 'master', 'trunk', 'develop']),
  /** Include the project's own main tree, not just its worktrees. */
  includeMainTree: z.boolean().default(true),
});

export const mirrorSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }),
  z.object({
    type: z.literal('rsync-ssh'),
    /** An rsync destination, e.g. `user@host:/srv/transcripts/`. */
    target: z.string().min(1),
    timeoutSeconds: z.number().int().positive().default(120),
  }),
  z.object({
    type: z.literal('git-remote'),
    /** A git remote URL the transcript store is pushed to. */
    target: z.string().min(1),
    branch: z.string().default('main'),
    timeoutSeconds: z.number().int().positive().default(180),
  }),
]);

export const successorSchema = z.object({
  launcher: z.enum(['tmux', 'screen', 'none']).default('none'),
  /** tmux/screen session to open the successor in. Empty = pick or create one. */
  session: z.string().default(''),
  windowName: z.string().default('rotorcc'),
  /**
   * argv for the successor. `{{prompt}}` is replaced with the rendered resume
   * prompt. Defaults to resuming the most recent conversation in the project.
   */
  command: commandSchema.default(['claude', '--continue', '{{prompt}}']),
  /** Working directory for the successor; empty = the first configured project. */
  cwd: z.string().default(''),
  readyTimeoutSeconds: z.number().int().positive().default(90),
  /** If the prompt has not appeared by `readyTimeoutSeconds`, type it in. */
  sendKeysFallback: z.boolean().default(true),
  resumePrompt: z
    .string()
    .default(
      'rotorcc resume: read {{manifestMarkdown}} and continue every lane from its ' +
        'recorded next step. Work already committed and pushed does not need redoing.',
    ),
});

export const retireSchema = z.object({
  /**
   * Close the predecessor's terminal window once it has gone quiet. Off by
   * default: killing a window is the one irreversible thing rotorcc can do, and
   * a stranger's machine should have to opt in.
   */
  killOldWindow: z.boolean().default(false),
  /** How long the transcript must be idle before the window counts as quiet. */
  quiesceSeconds: z.number().int().positive().default(180),
  /** Give up waiting for quiet after this long, and leave the window alone. */
  maxWaitSeconds: z.number().int().positive().default(1800),
});

export const secretsScreenSchema = z.object({
  enabled: z.boolean().default(true),
  /** Extra regular expressions, as source strings, applied case-sensitively. */
  extraPatterns: z.array(z.string()).default([]),
  /** Cap on how much of a new file is scanned, in bytes. */
  maxScanBytes: z
    .number()
    .int()
    .positive()
    .default(8 * 1024 * 1024),
  /**
   * What a hit does.
   *
   *   mirror-only  copy locally, refuse the off-machine mirror. The default,
   *                because those bytes are already at rest on this disk and
   *                declining to back them up protects nothing while leaving
   *                the session unrecoverable.
   *   skip-file    do not copy that file into the store at all. Choose this
   *                where the store is more durable or more widely readable
   *                than the transcripts themselves — a git store keeps history
   *                the originals may not, and git history is hard to purge.
   *   fail-closed  abandon the whole snapshot. Strictest, and it means one
   *                credential-shaped string in one transcript stops every
   *                transcript being backed up. Know that before choosing it.
   */
  onHit: z.enum(['mirror-only', 'skip-file', 'fail-closed']).default('mirror-only'),
});

export const hardKillSchema = z.object({
  enabled: z.boolean().default(true),
  /** Literal strings whose appearance in the transcript tail means "limit hit". */
  transcriptSignatures: z
    .array(z.string())
    .default([
      "You've hit your session limit",
      "You've hit your usage limit",
      'Claude usage limit reached',
      'You have exceeded your usage limit',
    ]),
  /** Bytes of transcript tail to scan each tick. */
  tailBytes: z
    .number()
    .int()
    .positive()
    .default(64 * 1024),
  /** No transcript write for this long, with no live process, means dead. */
  deadAfterSeconds: z.number().int().positive().default(600),
});

export const snapshotSchema = z.object({
  /** Ignore a snapshot request that arrives this soon after the last one. */
  debounceSeconds: z.number().int().nonnegative().default(45),
  /** Skip files larger than this. 0 disables the limit. */
  maxFileBytes: z
    .number()
    .int()
    .nonnegative()
    .default(1024 * 1024 * 1024),
  /** Run `git gc` in the store when the last one is older than this. */
  gcDays: z.number().int().positive().default(7),
  /** Subdirectories of each project transcript directory to copy. */
  include: z.array(z.string()).default(['.']),
  /** Path fragments to skip, matched against the store-relative path. */
  exclude: z.array(z.string()).default([]),
});

export const commandsSchema = z.object({
  git: commandSchema.default(['git']),
  /** The account switcher rotorcc reads usage from and switches through. */
  cswap: commandSchema.default(['cswap']),
  tmux: commandSchema.default(['tmux']),
  screen: commandSchema.default(['screen']),
  rsync: commandSchema.default(['rsync']),
  /** Optional; used only to list open pull requests in the manifest. */
  gh: commandSchema.default(['gh']),
});

export const manifestExtraSchema = z.object({
  label: z.string().min(1),
  command: commandSchema,
  timeoutSeconds: z.number().int().positive().default(30),
  maxBytes: z
    .number()
    .int()
    .positive()
    .default(8 * 1024),
});

export const configSchema = z.object({
  version: z.literal(1).default(1),

  /** Where Claude Code keeps its own state. Auto-detected by `rotorcc init`. */
  claudeHome: z.string().min(1),

  projects: z.array(projectSchema).min(1),

  /** The git repository rotorcc copies transcripts into. */
  storePath: z.string().min(1),

  /**
   * Where rotorcc keeps the accounts it manages.
   *
   * Empty means the platform default (see `appPaths().accountsDir`). Set it to
   * put the account store on an encrypted volume, or to run a second isolated
   * rotorcc on one machine. It holds credentials, so it is created 0700 and
   * every file in it 0600; do not point it at a synced folder.
   */
  accountsDir: z.string().default(''),

  /**
   * How a rotation target is chosen.
   *
   *   work-aware      the default, and rotorcc's reason for existing: prefer a
   *                   target with enough headroom to FINISH what is running,
   *                   and refuse rather than move onto one that would run out
   *                   mid-task.
   *   best            most headroom wins.
   *   next-available  the next slot in order, skipping exhausted ones.
   *   consume-first   soonest-resetting window first, to spend quota that is
   *                   about to be thrown away.
   */
  strategy: z.enum(['work-aware', 'best', 'next-available', 'consume-first']).default('work-aware'),

  /**
   * Refuse to rotate while work is unsaved.
   *
   * On by default. rotorcc checkpoints first and re-checks; anything still
   * unsaved after that is something it could not save — a protected branch, a
   * tree mid-rebase, a branch with no remote — and rotating past it ends the
   * session that owns the work. Turning this off makes rotorcc behave like a
   * plain account switcher, which is a choice, not a default.
   */
  refuseRotationWithUnsavedWork: z.boolean().default(true),

  mirror: mirrorSchema.default({ type: 'none' }),

  thresholds: z
    .object({
      /** Log a warning at this much headroom left. */
      warnPct: pct.default(15),
      /** Checkpoint everything at this much headroom left. */
      softPct: pct.default(10),
      /** Write the manifest, switch accounts, launch the successor. */
      rotatePct: pct.default(5),
    })
    .default({}),

  /**
   * The master switch for switching accounts.
   *
   * Turn it off and rotorcc becomes a pure durability tool: it still watches
   * headroom, still warns, still checkpoints everything at the soft threshold,
   * still writes the manifest at the rotate threshold, still recovers a crashed
   * session — it just never switches accounts and never launches a successor,
   * and says so in the flag it raises.
   *
   * This exists because "should this machine switch accounts automatically?" is
   * a policy question, not a configuration detail. Some environments forbid it.
   * Making that a single, explicit, auditable boolean is better than expecting
   * an operator to infer it from a threshold set to zero.
   */
  rotation: z
    .object({
      enabled: z.boolean().default(true),
      /**
       * How a rotation is carried out. See `docs/adr/0003-live-credential-hot-swap.md`.
       *
       *   hotswap    change the credential under the LIVE session and let it
       *              keep running. No successor, no new pane, no lost context.
       *              A Claude Code session reads its credential per request, so
       *              the next request uses the new account — measured, not
       *              assumed, on 2026-08-19 against v2.1.235.
       *   successor  the older abandon-and-replace path: checkpoint, switch,
       *              and launch a replacement session pointed at the manifest.
       *              Kept fully working, because hot-swap is an undocumented
       *              behaviour of a client nobody here controls and it may stop
       *              being true in any release.
       *   auto       the default. Hot-swap, verify it took, and fall back to a
       *              successor on EVIDENCE that it did not — never merely on
       *              the absence of evidence that it did, because falling back
       *              means replacing a session that is very likely still fine.
       */
      mode: z.enum(['auto', 'hotswap', 'successor']).default('auto'),
      /**
       * How long to watch the live session for an authentication failure after
       * a hot swap before calling it good. Zero disables the watch, which also
       * disables `auto`'s ability to detect a failed swap.
       */
      hotswapVerifySeconds: z.number().int().nonnegative().default(20),
    })
    .default({}),

  /**
   * The WEEKLY handover point, in headroom remaining.
   *
   * The weekly window is the priority signal, not the 5-hour one. The 5-hour
   * window refills several times a day, so burning a second account's week to
   * escape it is a bad trade; the weekly budget is the one an operator actually
   * regrets spending early. At or below this, rotorcc records that the NEXT
   * session should open on a different account.
   *
   * 5 means "hand over when 5% of the week is left", i.e. 95% utilised.
   */
  weeklyRotatePct: pct.default(5),

  /** Warn (do not act) once weekly headroom falls to this. */
  weeklyWarnPct: pct.default(20),

  /** Refuse to rotate unless some other account has at least this much left. */
  minTargetHeadroomPct: pct.default(20),
  /** Headroom must climb this far above a threshold before its latch resets. */
  hysteresisPct: pct.default(5),
  /** Minimum gap between two rotations. */
  cooldownSeconds: z.number().int().nonnegative().default(900),
  /** Daemon poll interval. */
  pollSeconds: z.number().int().min(15).default(60),
  /** Per-model weekly windows to count, by the name the usage source reports. */
  models: z.array(z.string()).default([]),

  snapshot: snapshotSchema.default({}),
  secretsScreen: secretsScreenSchema.default({}),
  hardKill: hardKillSchema.default({}),
  successor: successorSchema.default({}),
  retire: retireSchema.default({}),
  commands: commandsSchema.default({}),

  /** Extra read-only commands whose output is captured into every manifest. */
  manifestExtras: z.array(manifestExtraSchema).default([]),
  /** Ask `gh` for open pull requests when building a manifest. */
  manifestIncludePullRequests: z.boolean().default(false),

  logging: z
    .object({
      file: z.string().default(''),
      level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
      maxBytes: z
        .number()
        .int()
        .positive()
        .default(8 * 1024 * 1024),
    })
    .default({}),

  /** Evaluate and report, but never commit, push, mirror, switch or launch. */
  dryRun: z.boolean().default(false),
});

export type Config = z.infer<typeof configSchema>;
export type ProjectConfig = z.infer<typeof projectSchema>;
export type MirrorConfig = z.infer<typeof mirrorSchema>;
export type SuccessorConfig = z.infer<typeof successorSchema>;
export type CommandsConfig = z.infer<typeof commandsSchema>;
export type ManifestExtra = z.infer<typeof manifestExtraSchema>;
