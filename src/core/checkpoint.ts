/**
 * One checkpoint: copy the transcripts, commit and push every lane, and
 * optionally write the manifest.
 *
 * This is the operation every trigger funnels into — a hook, a threshold, a
 * hard kill, a manual `rotorcc snapshot`. Keeping it in one place is what makes
 * "the loss window is one tool call" true rather than aspirational: there is
 * exactly one code path that makes work durable, and it is the same one
 * whichever way it was reached.
 */
import { existsSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import type { Config } from '../config/schema.js';
import { VERSION } from '../version.js';
import type { RotorState } from './decide.js';
import type { Logger } from './log.js';
import { type Manifest, renderManifestMarkdown, treeToManifest } from './manifest.js';
import { projectSlug } from './paths.js';
import { run } from './proc.js';
import { type SnapshotResult, type SnapshotSource, snapshot } from './snapshot.js';
import { Store, timestampSlug } from './state.js';
import { type SessionFile, allSessions, projectTranscriptDir } from './transcripts.js';
import type { BackgroundTask } from './hookPayload.js';
import type { AccountReading, UsageReading } from './usage.js';
import {
  type CheckpointOutcome,
  type TreeStatus,
  checkpointProject,
  matchesGlob,
} from './worktrees.js';

export interface CheckpointInput {
  config: Config;
  store: Store;
  logger: Logger;
  trigger: string;
  dryRun: boolean;
  /** Session the trigger came from, when a hook supplied one. */
  session?:
    | {
        id: string | null;
        transcriptPath: string | null;
        cwd: string | null;
        backgroundTasks: BackgroundTask[];
        lastAssistantMessage: string | null;
      }
    | undefined;
  /** Skip the transcript copy; used when a snapshot just ran. */
  skipSnapshot?: boolean;
  /**
   * Copy transcripts but do not touch git in the projects. Used for compaction,
   * where context is about to be lost but no code has changed.
   */
  skipLanes?: boolean;
  /** Leave the off-machine mirror to the scheduled tick. Set by hooks. */
  skipMirror?: boolean;
  /**
   * Commit dirty files before pushing (default true). Routine hook events pass
   * false so that only already-committed work is pushed; the terminal paths —
   * SessionEnd, rotation, crash reconstruction — keep the default.
   */
  commitDirty?: boolean;
  usage?: UsageReading | undefined;
  targetAccount?: number | undefined;
  writeManifest?: boolean;
  cleanExit?: boolean;
}

export interface CheckpointResult {
  snapshot: SnapshotResult | null;
  projects: Array<{ project: string; trees: TreeStatus[]; outcomes: CheckpointOutcome[] }>;
  manifestPath: string | null;
  manifestMarkdownPath: string | null;
  manifest: Manifest | null;
}

/** Every transcript directory rotorcc should copy, plus the memory directory. */
export function snapshotSources(
  config: Config,
  extraTranscriptPaths: string[] = [],
): SnapshotSource[] {
  const sources = new Map<string, SnapshotSource>();
  for (const project of config.projects) {
    const dir = projectTranscriptDir(config, project.path);
    if (existsSync(dir)) {
      sources.set(dir, { from: dir, to: join('projects', projectSlug(project.path)) });
    }
  }
  // A hook hands over the real transcript path, which covers worktrees and any
  // directory whose slug rotorcc would not have guessed.
  for (const transcriptPath of extraTranscriptPaths) {
    const dir = join(transcriptPath, '..');
    if (!existsSync(dir)) continue;
    const slug =
      dir
        .split(sep)
        .filter((p) => p !== '')
        .pop() ?? 'unknown';
    if (!sources.has(dir)) sources.set(dir, { from: dir, to: join('projects', slug) });
  }
  return [...sources.values()];
}

function listNotes(treePath: string, globs: string[]): string[] {
  if (globs.length === 0) return [];
  const found: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 4) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name === 'node_modules' || name === '.git') continue;
      const full = join(dir, name);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      const rel = relative(treePath, full).split(sep).join('/');
      if (stat.isDirectory()) walk(full, depth + 1);
      else if (globs.some((glob) => matchesGlob(rel, glob))) found.push(rel);
    }
  };
  walk(treePath, 0);
  return found.sort();
}

async function collectPullRequests(
  config: Config,
  projectPath: string,
): Promise<Array<{ number: number; title: string; branch: string; url: string }>> {
  if (!config.manifestIncludePullRequests) return [];
  const result = await run(
    [
      ...config.commands.gh,
      'pr',
      'list',
      '--json',
      'number,title,headRefName,url',
      '--limit',
      '30',
    ],
    { cwd: projectPath, timeoutMs: 30_000 },
  );
  if (!result.ok) return [];
  try {
    const parsed = JSON.parse(result.stdout) as Array<{
      number: number;
      title: string;
      headRefName: string;
      url: string;
    }>;
    return parsed.map((pr) => ({
      number: pr.number,
      title: pr.title,
      branch: pr.headRefName,
      url: pr.url,
    }));
  } catch {
    return [];
  }
}

async function collectExtras(
  config: Config,
  logger: Logger,
): Promise<Array<{ label: string; output: string }>> {
  const extras: Array<{ label: string; output: string }> = [];
  for (const extra of config.manifestExtras) {
    const result = await run(extra.command, { timeoutMs: extra.timeoutSeconds * 1000 });
    const text = (result.stdout || result.stderr || result.error || '').slice(0, extra.maxBytes);
    if (!result.ok) logger.warn('manifest extra failed', { label: extra.label });
    extras.push({ label: extra.label, output: text });
  }
  return extras;
}

function accountLabel(account: AccountReading): string {
  return account.alias ?? account.email ?? `account ${account.number}`;
}

function nextCommands(config: Config, result: CheckpointResult): string[] {
  const commands: string[] = ['rotorcc status'];
  for (const project of result.projects) {
    for (const [index, tree] of project.trees.entries()) {
      const outcome = project.outcomes[index];
      if (outcome?.error !== null && outcome !== undefined) {
        commands.push(`# ${tree.path}: ${outcome.error} — fix by hand`);
      } else if (outcome?.skipped?.includes('no remote') === true) {
        commands.push(
          `git -C ${tree.path} remote add origin <url> && git -C ${tree.path} push -u origin ${tree.branch}`,
        );
      } else if (tree.protectedBranch && (tree.dirtyFiles > 0 || (tree.ahead ?? 0) > 0)) {
        commands.push(
          `git -C ${tree.path} status   # protected branch with work rotorcc will not touch`,
        );
      }
    }
  }
  void config;
  return commands;
}

export async function performCheckpoint(input: CheckpointInput): Promise<CheckpointResult> {
  const { config, store, logger, trigger, dryRun } = input;

  const result: CheckpointResult = {
    snapshot: null,
    projects: [],
    manifestPath: null,
    manifestMarkdownPath: null,
    manifest: null,
  };

  if (input.skipSnapshot !== true) {
    const extraPaths =
      input.session?.transcriptPath !== null && input.session?.transcriptPath !== undefined
        ? [input.session.transcriptPath]
        : [];
    result.snapshot = await snapshot({
      config,
      sources: snapshotSources(config, extraPaths),
      trigger,
      sessionId: input.session?.id ?? undefined,
      logger,
      dryRun,
      skipMirror: input.skipMirror === true,
    });
    logger.info('snapshot done', {
      files: result.snapshot.filesCopied,
      bytes: result.snapshot.bytesCopied,
      commit: result.snapshot.commit,
      mirror: result.snapshot.mirror.detail,
    });
  }

  const timestamp = new Date().toISOString();
  for (const project of input.skipLanes === true ? [] : config.projects) {
    const { trees, outcomes } = await checkpointProject({ git: config.commands.git }, project, {
      trigger,
      timestamp,
      dryRun,
      ...(input.commitDirty === undefined ? {} : { commitDirty: input.commitDirty }),
    });
    result.projects.push({ project: project.path, trees, outcomes });
    const pushedCount = outcomes.filter((o) => o.pushed).length;
    const errorCount = outcomes.filter((o) => o.error !== null).length;
    logger.info('lanes checkpointed', {
      project: project.path,
      trees: trees.length,
      pushed: pushedCount,
      errors: errorCount,
    });
  }

  if (input.writeManifest !== true) return result;

  const id = timestampSlug();
  const manifest: Manifest = {
    schemaVersion: 1,
    id,
    createdAt: timestamp,
    trigger,
    tool: { name: 'rotorcc', version: VERSION },
    session:
      input.session === undefined
        ? null
        : {
            id: input.session.id,
            transcriptPath: input.session.transcriptPath,
            cwd: input.session.cwd,
            backgroundTasks: input.session.backgroundTasks.map((task) => ({
              id: task.id,
              type: task.type ?? null,
              status: task.status ?? null,
              description: task.description ?? null,
              agentType: task.agent_type ?? null,
            })),
            lastAssistantMessage: input.session.lastAssistantMessage,
          },
    accounts: {
      activeNumber: input.usage?.activeAccountNumber ?? null,
      targetNumber: input.targetAccount ?? null,
      observedAt: input.usage?.observedAt ?? timestamp,
      list: (input.usage?.accounts ?? []).map((account) => ({
        number: account.number,
        label: accountLabel(account),
        headroomPct: account.headroomPct,
        bindingWindow: account.bindingWindow,
        resetsAt: account.bindingResetsAt ?? null,
        active: account.active,
      })),
    },
    projects: await Promise.all(
      result.projects.map(async (entry) => {
        const project = config.projects.find((p) => p.path === entry.project);
        return {
          path: entry.project,
          trees: entry.trees.map((tree, index) =>
            treeToManifest(
              tree,
              entry.outcomes[index],
              listNotes(tree.path, project?.checkpointGlobs ?? []),
            ),
          ),
          pullRequests: await collectPullRequests(config, entry.project),
        };
      }),
    ),
    snapshot: {
      storePath: config.storePath,
      commit: result.snapshot?.commit ?? null,
      filesCopied: result.snapshot?.filesCopied ?? 0,
      bytesCopied: result.snapshot?.bytesCopied ?? 0,
      mirror: result.snapshot?.mirror ?? {
        attempted: false,
        ok: true,
        detail: 'snapshot skipped',
      },
      secretHits: result.snapshot?.secretHits.length ?? 0,
    },
    extras: await collectExtras(config, logger),
    nextCommands: nextCommands(config, result),
    cleanExit: input.cleanExit ?? false,
  };

  const jsonPath = store.absolute(join('manifests', `manifest-${id}.json`));
  const mdPath = store.absolute(join('manifests', `manifest-${id}.md`));
  store.ensure();
  writeFileSync(jsonPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  writeFileSync(mdPath, renderManifestMarkdown(manifest), 'utf8');

  result.manifest = manifest;
  result.manifestPath = jsonPath;
  result.manifestMarkdownPath = mdPath;
  logger.info('manifest written', { path: jsonPath });
  return result;
}

/** The most recently written session across every configured project. */
export function newestSessionAcrossProjects(
  config: Config,
): (SessionFile & { projectPath: string }) | null {
  return allSessions(config)[0] ?? null;
}

export function updateStateAfterCheckpoint(
  state: RotorState,
  result: CheckpointResult,
): RotorState {
  return {
    ...state,
    lastSnapshotAt: new Date().toISOString(),
    ...(result.manifestPath !== null ? { lastManifestPath: result.manifestPath } : {}),
  };
}
