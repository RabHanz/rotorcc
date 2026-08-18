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
 *     pushed somewhere plausible.
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
  hasRemote: boolean;
  remote: string | null;
  upstream: string | null;
  tip: string;
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
  if (upstream !== null) {
    const count = await git(ctx, treePath, ['rev-list', '--count', `${upstream}..HEAD`]);
    const value = Number.parseInt(count.stdout.trim(), 10);
    ahead = Number.isNaN(value) ? null : value;
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
    hasRemote: remote !== null,
    remote,
    upstream,
    tip,
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

  const statuses: TreeStatus[] = [];
  for (const { path, isMainTree } of selected) {
    const status = await inspectTree(ctx, path, project, isMainTree);
    if (status !== null) statuses.push(status);
  }
  return statuses;
}

export interface CheckpointOptions {
  trigger: string;
  timestamp: string;
  dryRun: boolean;
  /** Commit message template; `{{trigger}}` and `{{timestamp}}` are replaced. */
  messageTemplate?: string;
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

  let committed = false;
  if (tree.dirtyFiles > 0) {
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
  const outcomes: CheckpointOutcome[] = [];
  for (const tree of trees) {
    outcomes.push(await checkpointTree(ctx, tree, options));
  }
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
