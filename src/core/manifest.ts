/**
 * The resume manifest: everything the successor needs so that nothing has to be
 * re-derived.
 *
 * It is deliberately two files. The JSON is the machine record — versioned,
 * schema-checked, round-trippable. The Markdown is what an agent is actually
 * told to read, because a resume note that reads like a handover note gets
 * acted on, and a wall of JSON gets summarised and half-lost.
 */
import { z } from 'zod';

import type { CheckpointOutcome, TreeStatus } from './worktrees.js';

export const manifestTreeSchema = z.object({
  path: z.string(),
  branch: z.string(),
  tip: z.string(),
  ahead: z.number().nullable(),
  dirtyFiles: z.number(),
  hasRemote: z.boolean(),
  protectedBranch: z.boolean(),
  isMainTree: z.boolean(),
  checkpoint: z
    .object({
      committed: z.boolean(),
      pushed: z.boolean(),
      skipped: z.string().nullable(),
      error: z.string().nullable(),
    })
    .nullable(),
  notes: z.array(z.string()).default([]),
});

export const manifestProjectSchema = z.object({
  path: z.string(),
  trees: z.array(manifestTreeSchema),
  pullRequests: z
    .array(z.object({ number: z.number(), title: z.string(), branch: z.string(), url: z.string() }))
    .default([]),
});

export const manifestAccountSchema = z.object({
  number: z.number(),
  label: z.string(),
  headroomPct: z.number(),
  bindingWindow: z.string(),
  resetsAt: z.string().nullable(),
  active: z.boolean(),
});

export const manifestSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string(),
  createdAt: z.string(),
  trigger: z.string(),
  tool: z.object({ name: z.literal('rotorcc'), version: z.string() }),
  session: z
    .object({
      id: z.string().nullable(),
      transcriptPath: z.string().nullable(),
      cwd: z.string().nullable(),
      backgroundTasks: z
        .array(
          z.object({
            id: z.string(),
            type: z.string().nullable(),
            status: z.string().nullable(),
            description: z.string().nullable(),
            agentType: z.string().nullable(),
          }),
        )
        .default([]),
      lastAssistantMessage: z.string().nullable(),
    })
    .nullable(),
  accounts: z.object({
    activeNumber: z.number().nullable(),
    targetNumber: z.number().nullable(),
    observedAt: z.string(),
    list: z.array(manifestAccountSchema),
  }),
  projects: z.array(manifestProjectSchema),
  snapshot: z.object({
    storePath: z.string(),
    commit: z.string().nullable(),
    filesCopied: z.number(),
    bytesCopied: z.number(),
    mirror: z.object({ attempted: z.boolean(), ok: z.boolean(), detail: z.string() }),
    secretHits: z.number(),
  }),
  extras: z.array(z.object({ label: z.string(), output: z.string() })).default([]),
  nextCommands: z.array(z.string()).default([]),
  /** False when the predecessor was killed rather than stopped. */
  cleanExit: z.boolean(),
});

export type Manifest = z.infer<typeof manifestSchema>;
export type ManifestTree = z.infer<typeof manifestTreeSchema>;

export function parseManifest(raw: unknown): Manifest {
  return manifestSchema.parse(raw);
}

export function treeToManifest(
  tree: TreeStatus,
  outcome: CheckpointOutcome | undefined,
  notes: string[] = [],
): ManifestTree {
  return {
    path: tree.path,
    branch: tree.branch,
    tip: tree.tip,
    ahead: tree.ahead,
    dirtyFiles: tree.dirtyFiles,
    hasRemote: tree.hasRemote,
    protectedBranch: tree.protectedBranch,
    isMainTree: tree.isMainTree,
    checkpoint:
      outcome === undefined
        ? null
        : {
            committed: outcome.committed,
            pushed: outcome.pushed,
            skipped: outcome.skipped,
            error: outcome.error,
          },
    notes,
  };
}

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * The human half. Written in the order a person recovering actually needs it:
 * what to do, then what is already safe, then the detail.
 */
export function renderManifestMarkdown(manifest: Manifest): string {
  const lines: string[] = [];
  const push = (s = '') => lines.push(s);

  push(`# Resume manifest ${manifest.id}`);
  push();
  push(
    `Written ${manifest.createdAt} by rotorcc ${manifest.tool.version}, trigger \`${manifest.trigger}\`.`,
  );
  push(
    manifest.cleanExit
      ? 'The previous session ended cleanly.'
      : 'The previous session did NOT end cleanly. Treat everything below as the source of truth.',
  );
  push();

  push('## Do this first');
  push();
  if (manifest.nextCommands.length === 0) {
    push('1. Nothing queued. Read the lane table and pick up where each branch stops.');
  } else {
    manifest.nextCommands.forEach((cmd, i) => push(`${i + 1}. \`${cmd}\``));
  }
  push();

  push('## Work already safe');
  push();
  const allTrees = manifest.projects.flatMap((p) => p.trees);
  const pushed = allTrees.filter((t) => t.checkpoint?.pushed === true);
  const committed = allTrees.filter(
    (t) => t.checkpoint?.committed === true && t.checkpoint.pushed !== true,
  );
  const stuck = allTrees.filter((t) => t.checkpoint?.error !== null && t.checkpoint !== null);
  push(`- Committed and pushed: ${pushed.length} tree(s).`);
  push(`- Committed, not pushed: ${committed.length} tree(s).`);
  push(`- Failed to checkpoint: ${stuck.length} tree(s).`);
  push(
    `- Transcript snapshot: ${manifest.snapshot.filesCopied} file(s), ${bytes(manifest.snapshot.bytesCopied)} new, commit \`${manifest.snapshot.commit ?? 'none'}\` in \`${manifest.snapshot.storePath}\`.`,
  );
  push(
    `- Off-machine mirror: ${
      manifest.snapshot.mirror.attempted
        ? manifest.snapshot.mirror.ok
          ? `ok — ${manifest.snapshot.mirror.detail}`
          : `FAILED — ${manifest.snapshot.mirror.detail}`
        : manifest.snapshot.mirror.detail
    }.`,
  );
  if (manifest.snapshot.secretHits > 0) {
    push(
      `- The secrets screen matched ${manifest.snapshot.secretHits} time(s); the mirror was refused for this snapshot. Review before mirroring by hand.`,
    );
  }
  push();

  if (manifest.session !== null) {
    push('## Session');
    push();
    push(`- id: \`${manifest.session.id ?? 'unknown'}\``);
    push(`- transcript: \`${manifest.session.transcriptPath ?? 'unknown'}\``);
    push(`- cwd: \`${manifest.session.cwd ?? 'unknown'}\``);
    if (manifest.session.backgroundTasks.length > 0) {
      push(`- background tasks still registered when the manifest was written:`);
      for (const task of manifest.session.backgroundTasks) {
        push(
          `  - \`${task.id}\` ${task.type ?? 'task'} · ${task.status ?? 'unknown'} · ${task.description ?? 'no description'}${task.agentType !== null ? ` · ${task.agentType}` : ''}`,
        );
      }
      push('  These do not survive the switch. Re-dispatch any that had not finished.');
    } else {
      push('- No background tasks were registered.');
    }
    push();
  }

  push('## Lanes');
  push();
  for (const project of manifest.projects) {
    push(`### ${project.path}`);
    push();
    push('| tree | branch | tip | unpushed | dirty | checkpoint |');
    push('| --- | --- | --- | --- | --- | --- |');
    for (const tree of project.trees) {
      const cp = tree.checkpoint;
      const state =
        cp === null
          ? '—'
          : cp.error !== null
            ? `ERROR: ${cp.error}`
            : cp.skipped !== null
              ? cp.skipped
              : `${cp.committed ? 'committed' : 'clean'}${cp.pushed ? ' + pushed' : ''}`;
      push(
        `| \`${tree.path}\` | ${tree.branch}${tree.protectedBranch ? ' (protected)' : ''} | ${tree.tip || '—'} | ${tree.ahead ?? '?'} | ${tree.dirtyFiles} | ${state} |`,
      );
    }
    push();
    for (const tree of project.trees) {
      if (tree.notes.length > 0) {
        push(`Resume notes in \`${tree.path}\`:`);
        for (const note of tree.notes) push(`- \`${note}\``);
        push();
      }
    }
    if (project.pullRequests.length > 0) {
      push('Open pull requests:');
      for (const pr of project.pullRequests) {
        push(`- #${pr.number} ${pr.title} (${pr.branch}) ${pr.url}`);
      }
      push();
    }
  }

  push('## Accounts');
  push();
  push('| # | account | headroom | binding window | resets |');
  push('| --- | --- | --- | --- | --- |');
  for (const account of manifest.accounts.list) {
    push(
      `| ${account.number}${account.active ? ' (active)' : ''} | ${account.label} | ${account.headroomPct.toFixed(0)}% | ${account.bindingWindow} | ${account.resetsAt ?? '—'} |`,
    );
  }
  if (manifest.accounts.targetNumber !== null) {
    push();
    push(`Rotating to account ${manifest.accounts.targetNumber}.`);
  }
  push();

  if (manifest.extras.length > 0) {
    push('## Environment');
    push();
    for (const extra of manifest.extras) {
      push(`### ${extra.label}`);
      push();
      push('```');
      push(extra.output.trimEnd());
      push('```');
      push();
    }
  }

  push('---');
  push();
  push(
    'Written automatically. Nothing in this file needs re-deriving: every branch, tip and ' +
      'push state above was read from git at the moment the manifest was written.',
  );
  push();
  return lines.join('\n');
}
