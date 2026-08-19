/**
 * Finding every tree that might be holding uncommitted work, and getting that
 * work somewhere durable.
 *
 * The rules this module will not break, because breaking any of them turns a
 * recovery tool into a way to lose work:
 *
 *   - never commit or push on a protected branch;
 *   - never force-push, ever, under any flag;
 *   - never commit while a merge, rebase, cherry-pick or bisect is in flight,
 *     because `git add -A` mid-conflict commits the conflict markers;
 *   - never invent a remote: a branch with nowhere to go is reported, not
 *     pushed somewhere plausible;
 *   - **never act on a stale reading, and never publish a tip that is not a
 *     descendant of what it would overwrite.** See below.
 *
 * ## The 2026-08-19 data-loss defect
 *
 * The sweep committed a stale worktree over newer work on one branch three
 * times in forty minutes, and pushed each time. The shape was a loop rather
 * than a one-off race: committing advanced the branch, advancing the branch
 * re-dirtied the stale tree, and the next sweep committed it again. The branch
 * survived only because a human's push happened to land last.
 *
 * Two structural guards now make that impossible rather than unlikely:
 *
 *   1. **A plan is void if the tree moved under it.** `inspectTree` records the
 *      exact HEAD it read. `checkpointTree` re-reads HEAD immediately before
 *      staging, and refuses if it has changed. Everything the sweep decides —
 *      dirty or clean, ahead or not, safe or not — is a function of a reading
 *      taken up to several seconds earlier, across four concurrent trees and a
 *      transcript snapshot. Acting on it after the world moved is how a stale
 *      tree gets committed on top of work that arrived in between.
 *
 *   2. **A push must be a genuine fast-forward, checked here.** Before pushing,
 *      the remote-tracking ref must be an ANCESTOR of the local tip. rotorcc
 *      never force-pushes, so a non-descendant push would be rejected by the
 *      server anyway — but relying on that means rotorcc has already made the
 *      bad commit and only found out afterwards, and it says nothing about a
 *      remote whose newer state we have not fetched. Checking it here turns
 *      "the server said no" into "rotorcc declined, and said why".
 *
 * Neither guard costs anything when things are normal: one `rev-parse` and one
 * `merge-base --is-ancestor` per tree.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import type { ProjectConfig } from '../config/schema.js';
import { type RunResult, run } from './proc.js';

export interface TreeStatus {
  path: string;
  branch: string;
  detached: boolean;
  protectedBranch: boolean;
  dirtyFiles: number;
  /** Commits ahead of the upstream, or null when there is no upstream yet. */
  ahead: number | null;
  /** Commits the upstream has that this tree does not. Null without an upstream. */
  behind: number | null;
  hasRemote: boolean;
  remote: string | null;
  upstream: string | null;
  tip: string;
  /**
   * The exact commit this reading was taken at. Null on a branch with no commit
   * yet, which is a legitimate state and not an error.
   *
   * Everything the sweep later does is a plan made against THIS commit. If HEAD
   * has moved by the time the plan runs, the plan is about a repository that no
   * longer exists and must be discarded rather than applied.
   */
  headSha: string | null;
  /** A merge/rebase/cherry-pick/bisect is in progress. */
  midOperation: string | null;
  isMainTree: boolean;
}

export interface CheckpointOutcome {
  tree: string;
  branch: string;
  committed: boolean;
  pushed: boolean;
  skipped: string | null;
  error: string | null;
}

/**
 * Glob matching over a path relative to the project root, always with `/`
 * separators. `*` matches within one segment, `**` matches across segments,
 * `?` matches one character.
 */
export function matchesGlob(relativePath: string, glob: string): boolean {
  const normalised = relativePath.split(sep).join('/').replace(/^\.\//, '');
  const source = glob.split(sep).join('/');
  let pattern = '';
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === '*') {
      if (source[i + 1] === '*') {
        if (source[i + 2] === '/') {
          pattern += '(?:.*/)?';
          i += 3;
        } else {
          pattern += '.*';
          i += 2;
        }
      } else {
        pattern += '[^/]*';
        i += 1;
      }
    } else if (ch === '?') {
      pattern += '[^/]';
      i += 1;
    } else {
      pattern += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
      i += 1;
    }
  }
  return new RegExp(`^${pattern}$`).test(normalised);
}

export interface WorktreeEntry {
  path: string;
  branch: string;
  detached: boolean;
}

export function parseWorktreeList(porcelain: string): WorktreeEntry[] {
  const trees: WorktreeEntry[] = [];
  let current: WorktreeEntry | null = null;
  for (const line of porcelain.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      if (current !== null) trees.push(current);
      current = { path: line.slice('worktree '.length), branch: '', detached: false };
    } else if (line.startsWith('branch ') && current !== null) {
      current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
    } else if (line === 'detached' && current !== null) {
      current.detached = true;
    }
  }
  if (current !== null) trees.push(current);
  return trees;
}

function midOperationFor(treePath: string): string | null {
  const gitPath = join(treePath, '.git');
  let gitDir = gitPath;
  try {
    // A linked worktree's `.git` is a file pointing at the real gitdir.
    const pointer = readFileSync(gitPath, 'utf8');
    const match = /^gitdir:\s*(.+)$/m.exec(pointer);
    if (match?.[1] !== undefined) gitDir = match[1].trim();
  } catch {
    /* `.git` is a directory: the path above is already right */
  }
  const markers: Array<[string, string]> = [
    ['MERGE_HEAD', 'merge'],
    ['rebase-merge', 'rebase'],
    ['rebase-apply', 'rebase'],
    ['CHERRY_PICK_HEAD', 'cherry-pick'],
    ['REVERT_HEAD', 'revert'],
    ['BISECT_LOG', 'bisect'],
  ];
  for (const [marker, name] of markers) {
    if (existsSync(join(gitDir, marker))) return name;
  }
  return null;
}

export interface GitContext {
  git: string[];
  timeoutMs?: number;
}

async function git(ctx: GitContext, cwd: string, args: string[]): Promise<RunResult> {
  return run([...ctx.git, ...args], { cwd, timeoutMs: ctx.timeoutMs ?? 60_000, okCodes: [1] });
}

/** `origin` when it exists, otherwise the first remote, otherwise null. */
export function pickRemote(remoteList: string): string | null {
  const remotes = remoteList
    .split(/\r?\n/)
    .map((r) => r.trim())
    .filter((r) => r !== '');
  if (remotes.includes('origin')) return 'origin';
  return remotes[0] ?? null;
}

export async function inspectTree(
  ctx: GitContext,
  treePath: string,
  project: ProjectConfig,
  isMainTree: boolean,
): Promise<TreeStatus | null> {
  // `symbolic-ref` answers correctly on a branch with no commits yet, where
  // `rev-parse --abbrev-ref HEAD` prints the literal "HEAD" and looks detached.
  // A repository whose first commit has not happened still holds real work.
  const symbolic = await git(ctx, treePath, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  let branch = symbolic.code === 0 ? symbolic.stdout.trim() : '';
  let detached = false;
  if (branch === '') {
    const head = await git(ctx, treePath, ['rev-parse', '--abbrev-ref', 'HEAD']);
    branch = head.stdout.trim();
    if (branch === '') return null;
    detached = true;
  }

  // HEAD FIRST, before anything else is measured.
  //
  // Everything below describes the tree as of some commit, and the staleness
  // guard in `checkpointTree` compares against this value. Reading it last —
  // after the dirty count, after the ahead/behind counts — records a HEAD the
  // rest of the reading was not taken at, so a commit landing mid-inspection
  // produces a reading that describes the old tree and a sha that matches the
  // new one. The guard would then pass on exactly the case it exists for.
  const headResult = await git(ctx, treePath, ['rev-parse', 'HEAD']);
  const headSha = headResult.code === 0 ? headResult.stdout.trim() || null : null;

  const status = await git(ctx, treePath, ['status', '--porcelain']);
  const dirtyFiles = status.stdout.split(/\r?\n/).filter((l) => l.trim() !== '').length;

  const upstreamResult = await git(ctx, treePath, [
    'rev-parse',
    '--abbrev-ref',
    '--symbolic-full-name',
    '@{u}',
  ]);
  const upstream = upstreamResult.code === 0 ? upstreamResult.stdout.trim() : null;

  let ahead: number | null = null;
  let behind: number | null = null;
  if (upstream !== null) {
    // Both directions in one call. Asking only for `ahead` is what let a tree
    // that was BEHIND its upstream look like an ordinary candidate.
    const count = await git(ctx, treePath, [
      'rev-list',
      '--left-right',
      '--count',
      `${upstream}...HEAD`,
    ]);
    const [behindRaw, aheadRaw] = count.stdout.trim().split(/\s+/);
    const behindValue = Number.parseInt(behindRaw ?? '', 10);
    const aheadValue = Number.parseInt(aheadRaw ?? '', 10);
    behind = Number.isNaN(behindValue) ? null : behindValue;
    ahead = Number.isNaN(aheadValue) ? null : aheadValue;
  }

  const remotes = await git(ctx, treePath, ['remote']);
  const remote = pickRemote(remotes.stdout);
  const tip = (await git(ctx, treePath, ['log', '--oneline', '-1'])).stdout.trim();

  return {
    path: treePath,
    branch,
    detached,
    protectedBranch: project.protectedBranches.includes(branch),
    dirtyFiles,
    ahead,
    behind,
    hasRemote: remote !== null,
    remote,
    upstream,
    tip,
    headSha,
    midOperation: midOperationFor(treePath),
    isMainTree,
  };
}

export async function discoverTrees(
  ctx: GitContext,
  project: ProjectConfig,
): Promise<TreeStatus[]> {
  const listed = await git(ctx, project.path, ['worktree', 'list', '--porcelain']);
  if (listed.stdout.trim() === '') return [];
  const entries = parseWorktreeList(listed.stdout);

  const selected: Array<{ path: string; isMainTree: boolean }> = [];
  for (const entry of entries) {
    const rel = relative(project.path, entry.path);
    const isMainTree = rel === '' || rel === '.';
    if (isMainTree) {
      if (project.includeMainTree) selected.push({ path: entry.path, isMainTree: true });
      continue;
    }
    // A worktree outside the configured project is not this project's business.
    if (rel.startsWith('..')) continue;
    if (project.worktreeGlobs.some((glob) => matchesGlob(rel, glob))) {
      selected.push({ path: entry.path, isMainTree: false });
    }
  }

  // Inspecting one tree is six git calls. A project with fifty agent worktrees
  // is three hundred, and done one at a time that is minutes of wall clock in
  // the middle of a checkpoint. Bounded rather than unbounded because this runs
  // on the machine somebody is working on, and a fork bomb of git processes is
  // not an improvement.
  const statuses = await mapWithConcurrency(selected, TREE_CONCURRENCY, ({ path, isMainTree }) =>
    inspectTree(ctx, path, project, isMainTree),
  );
  return statuses.filter((s): s is TreeStatus => s !== null);
}

/** How many trees are inspected or checkpointed at once. */
export const TREE_CONCURRENCY = 4;

export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index] as T, index);
    }
  });
  await Promise.all(runners);
  return results;
}

export interface CheckpointOptions {
  trigger: string;
  timestamp: string;
  dryRun: boolean;
  /** Commit message template; `{{trigger}}` and `{{timestamp}}` are replaced. */
  messageTemplate?: string;
  /**
   * Whether to `git add -A && git commit` a tree's dirty files before pushing.
   * Default true — the terminal paths (session end, rotation, crash
   * reconstruction) need it, because that is when uncommitted work would die.
   * Routine hook events set it false: they only push commits an agent already
   * made. Committing on every SubagentStop turned a perpetually-dirty tree into
   * a commit-and-push every few minutes, which spams history and cancels the
   * project's CI run each time (found in production dogfood, 2026-08-18).
   */
  commitDirty?: boolean;
}

export function checkpointMessage(options: CheckpointOptions): string {
  const template =
    options.messageTemplate ?? 'wip(rotorcc): auto-checkpoint {{trigger}} {{timestamp}}';
  return template
    .replace(/\{\{trigger\}\}/g, options.trigger)
    .replace(/\{\{timestamp\}\}/g, options.timestamp);
}

/**
 * Commit anything dirty, then push anything unpushed. Every refusal is reported
 * in `skipped` rather than swallowed: an operator reading the manifest needs to
 * know which trees rotorcc deliberately left alone, and why.
 */
export async function checkpointTree(
  ctx: GitContext,
  tree: TreeStatus,
  options: CheckpointOptions,
): Promise<CheckpointOutcome> {
  const base: CheckpointOutcome = {
    tree: tree.path,
    branch: tree.branch,
    committed: false,
    pushed: false,
    skipped: null,
    error: null,
  };

  if (tree.detached) return { ...base, skipped: 'detached HEAD' };
  if (tree.midOperation !== null) return { ...base, skipped: `${tree.midOperation} in progress` };
  if (tree.protectedBranch) {
    const note =
      tree.dirtyFiles > 0 || (tree.ahead ?? 0) > 0
        ? `protected branch ${tree.branch}: ${tree.dirtyFiles} dirty file(s), ${tree.ahead ?? 0} unpushed commit(s) left for a human`
        : `protected branch ${tree.branch}`;
    return { ...base, skipped: note };
  }

  // The reading this whole plan rests on may be seconds old: `discoverTrees`
  // inspects four trees at a time and a transcript snapshot can run in between.
  // If HEAD moved since then, something else committed, merged, pulled or reset
  // this tree, and every fact below — the dirty count above all — describes a
  // repository that no longer exists. Staging `-A` against the new HEAD in that
  // state is exactly how a stale working tree gets committed over newer work.
  //
  // Re-inspecting here instead of refusing was considered and rejected: the
  // next tick is sixty seconds away and will take a fresh reading anyway, and a
  // sweep that quietly re-plans mid-flight is a sweep nobody can reason about.
  if (tree.headSha !== null) {
    const headNow = await git(ctx, tree.path, ['rev-parse', 'HEAD']);
    const current = headNow.code === 0 ? headNow.stdout.trim() : '';
    if (current !== '' && current !== tree.headSha) {
      return {
        ...base,
        skipped:
          `HEAD moved from ${tree.headSha.slice(0, 8)} to ${current.slice(0, 8)} since this ` +
          'sweep looked at the tree; refusing to act on a stale reading',
      };
    }
  }

  let committed = false;
  const commitDirty = options.commitDirty ?? true;
  if (tree.dirtyFiles > 0 && !commitDirty) {
    // Routine trigger: leave the agent's uncommitted edits alone and only push
    // what it has already committed. The dirty count still reaches the manifest.
    if ((tree.ahead ?? 0) === 0) {
      return {
        ...base,
        skipped: `${tree.dirtyFiles} dirty file(s) left uncommitted (routine trigger)`,
      };
    }
  } else if (tree.dirtyFiles > 0) {
    if (options.dryRun) {
      return { ...base, skipped: `dry run: would commit ${tree.dirtyFiles} file(s) and push` };
    }
    const add = await git(ctx, tree.path, ['add', '-A']);
    if (add.code !== 0) return { ...base, error: `git add failed: ${add.stderr.trim()}` };
    const commit = await git(ctx, tree.path, ['commit', '-m', checkpointMessage(options)]);
    const output = `${commit.stdout}${commit.stderr}`;
    if (commit.code !== 0 && !/nothing to commit/i.test(output)) {
      return { ...base, error: `git commit failed: ${output.trim()}` };
    }
    committed = commit.code === 0;
  }

  const needsPush = committed || tree.ahead === null || (tree.ahead ?? 0) > 0;
  if (!needsPush) return { ...base, committed };
  if (!tree.hasRemote || tree.remote === null) {
    return { ...base, committed, skipped: 'no remote configured' };
  }
  if (options.dryRun) return { ...base, committed, skipped: 'dry run: would push' };

  // The descendant invariant. rotorcc publishes a tip only when the tip the
  // remote already has is an ANCESTOR of it — that is what "this push adds
  // history and removes none" means, stated as a check rather than as a hope.
  //
  // The server would reject a non-fast-forward too. That is not good enough:
  // by then rotorcc has already made the commit, and the failure arrives as a
  // push error the operator has to decode rather than as a refusal that names
  // the problem. It also says nothing about a tree that is simply behind.
  //
  // When the branch has no configured upstream the remote-tracking ref is
  // still the right thing to compare against, and it is often present: a
  // branch pushed from another machine leaves `<remote>/<branch>` here after
  // any fetch, with no `branch.<name>.merge` config. Skipping the check in that
  // case left the one shape the invariant is about — a remote ahead of us —
  // entirely to the server.
  const compareAgainst =
    tree.upstream ??
    (await (async (): Promise<string | null> => {
      if (tree.remote === null) return null;
      const ref = `${tree.remote}/${tree.branch}`;
      const exists = await git(ctx, tree.path, ['rev-parse', '--verify', '--quiet', ref]);
      return exists.code === 0 && exists.stdout.trim() !== '' ? ref : null;
    })());

  if (compareAgainst !== null) {
    const ancestor = await git(ctx, tree.path, [
      'merge-base',
      '--is-ancestor',
      compareAgainst,
      'HEAD',
    ]);
    if (ancestor.code !== 0) {
      return {
        ...base,
        committed,
        skipped:
          `not pushed: ${compareAgainst} is not an ancestor of this branch's tip` +
          (tree.behind === null || tree.behind === 0 ? '' : ` (${tree.behind} commit(s) behind)`) +
          '. Pushing would publish a history that drops work already on the remote. ' +
          'Anything dirty was committed locally and is safe; reconcile this by hand.',
      };
    }
  }

  // `-u` sets an upstream on a branch that has none. No force, no lease, no
  // exceptions: rotorcc only ever fast-forwards commits it just made itself.
  const push = await git(ctx, tree.path, ['push', '-u', tree.remote, tree.branch]);
  if (push.code !== 0) {
    return { ...base, committed, error: `git push failed: ${(push.stderr || push.stdout).trim()}` };
  }
  return { ...base, committed, pushed: true };
}

export async function checkpointProject(
  ctx: GitContext,
  project: ProjectConfig,
  options: CheckpointOptions,
): Promise<{ trees: TreeStatus[]; outcomes: CheckpointOutcome[] }> {
  const trees = await discoverTrees(ctx, project);
  // Each tree is its own working directory and its own branch, so there is no
  // index to contend over. Pushes to a shared remote in parallel are fine: they
  // touch different refs, and git serialises what it must.
  const outcomes = await mapWithConcurrency(trees, TREE_CONCURRENCY, (tree) =>
    checkpointTree(ctx, tree, options),
  );
  return { trees, outcomes };
}

/** Resume notes an operator left behind, collected into the manifest. */
export async function findCheckpointNotes(
  tree: TreeStatus,
  globs: string[],
  listFiles: (cwd: string) => Promise<string[]>,
): Promise<string[]> {
  if (globs.length === 0) return [];
  const files = await listFiles(tree.path);
  return files.filter((file) => globs.some((glob) => matchesGlob(file, glob)));
}
