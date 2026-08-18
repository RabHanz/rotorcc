/**
 * Real git, on a real fixture repository with a real bare remote. Mocking git
 * here would test the mock. The point of these tests is that a tool which runs
 * `git add -A && git commit && git push` unattended does so only where it is
 * safe, and these are the conditions under which it is safe.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { projectSchema } from '../src/config/schema.js';
import {
  checkpointMessage,
  checkpointTree,
  discoverTrees,
  inspectTree,
  matchesGlob,
  parseWorktreeList,
  pickRemote,
} from '../src/core/worktrees.js';
import { cleanup, tempDir } from './helpers.js';

const ctx = { git: ['git'] };
const options = { trigger: 'test', timestamp: '2026-08-18T00:00:00Z', dryRun: false };

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
    },
  });
}

let root: string;
let repo: string;
let remote: string;

const project = (overrides: Record<string, unknown> = {}) =>
  projectSchema.parse({ path: repo, ...overrides });

beforeEach(() => {
  root = tempDir('rotorcc-git-');
  repo = join(root, 'project');
  remote = join(root, 'remote.git');

  mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '--bare', '-b', 'main', remote]);
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'remote', 'add', 'origin', remote);
  writeFileSync(join(repo, 'README.md'), 'seed\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-m', 'seed');
  git(repo, 'push', '-u', 'origin', 'main');
});

afterEach(() => {
  cleanup(root);
});

describe('matchesGlob', () => {
  it.each([
    ['.claude/worktrees/agent-1', '.claude/worktrees/*', true],
    ['.claude/worktrees/nested/agent-1', '.claude/worktrees/*', false],
    ['.claude/worktrees/nested/agent-1', '.claude/worktrees/**', true],
    ['worktrees/a', '.claude/worktrees/*', false],
    ['notes/checkpoint-lane.md', '**/checkpoint-*.md', true],
    ['checkpoint-lane.md', '**/checkpoint-*.md', true],
    ['notes/deep/checkpoint-lane.md', '**/checkpoint-*.md', true],
    ['notes/summary.md', '**/checkpoint-*.md', false],
  ])('%s vs %s', (path, glob, expected) => {
    expect(matchesGlob(path, glob)).toBe(expected);
  });
});

describe('parseWorktreeList', () => {
  it('reads paths, branches and detached heads out of the porcelain form', () => {
    const parsed = parseWorktreeList(
      [
        'worktree /home/dev/project',
        'HEAD 1111111111111111111111111111111111111111',
        'branch refs/heads/main',
        '',
        'worktree /home/dev/project/.claude/worktrees/agent-1',
        'HEAD 2222222222222222222222222222222222222222',
        'detached',
        '',
      ].join('\n'),
    );
    expect(parsed).toEqual([
      { path: '/home/dev/project', branch: 'main', detached: false },
      { path: '/home/dev/project/.claude/worktrees/agent-1', branch: '', detached: true },
    ]);
  });
});

describe('pickRemote', () => {
  it('prefers origin, falls back to the first, and reports none', () => {
    expect(pickRemote('upstream\norigin\n')).toBe('origin');
    expect(pickRemote('upstream\nfork\n')).toBe('upstream');
    expect(pickRemote('\n')).toBeNull();
  });
});

describe('checkpointTree — the safety rules', () => {
  it('refuses to commit on a protected branch, and says what it left behind', async () => {
    writeFileSync(join(repo, 'work.txt'), 'uncommitted\n');
    const tree = await inspectTree(ctx, repo, project(), true);
    expect(tree?.protectedBranch).toBe(true);

    const result = await checkpointTree(ctx, tree!, options);
    expect(result.committed).toBe(false);
    expect(result.pushed).toBe(false);
    expect(result.skipped).toContain('protected branch main');
    expect(result.skipped).toContain('1 dirty file');
    // and the file really is still uncommitted
    expect(git(repo, 'status', '--porcelain')).toContain('work.txt');
  });

  it('commits and pushes a dirty feature branch', async () => {
    git(repo, 'switch', '-c', 'work/feature');
    writeFileSync(join(repo, 'work.txt'), 'uncommitted\n');

    const tree = await inspectTree(ctx, repo, project(), true);
    const result = await checkpointTree(ctx, tree!, options);

    expect(result.committed).toBe(true);
    expect(result.pushed).toBe(true);
    expect(result.error).toBeNull();
    expect(git(repo, 'status', '--porcelain').trim()).toBe('');
    expect(git(repo, 'log', '-1', '--format=%s')).toContain('auto-checkpoint test');
    // the commit is genuinely on the remote, not just locally
    expect(git(remote, 'log', '-1', '--format=%s', 'work/feature')).toContain('auto-checkpoint');
  });

  it('pushes a branch that is ahead even when nothing is dirty', async () => {
    git(repo, 'switch', '-c', 'work/ahead');
    git(repo, 'push', '-u', 'origin', 'work/ahead');
    writeFileSync(join(repo, 'a.txt'), 'a\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'by hand');

    const tree = await inspectTree(ctx, repo, project(), true);
    expect(tree?.ahead).toBe(1);
    const result = await checkpointTree(ctx, tree!, options);
    expect(result.committed).toBe(false);
    expect(result.pushed).toBe(true);
    expect(git(remote, 'log', '-1', '--format=%s', 'work/ahead')).toContain('by hand');
  });

  it('does nothing at all to a clean, fully pushed branch', async () => {
    git(repo, 'switch', '-c', 'work/clean');
    git(repo, 'push', '-u', 'origin', 'work/clean');
    const before = git(repo, 'rev-parse', 'HEAD');

    const tree = await inspectTree(ctx, repo, project(), true);
    const result = await checkpointTree(ctx, tree!, options);
    expect(result).toMatchObject({ committed: false, pushed: false, skipped: null, error: null });
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(before);
  });

  it('refuses to commit in the middle of a conflicted merge', async () => {
    git(repo, 'switch', '-c', 'work/left');
    writeFileSync(join(repo, 'conflict.txt'), 'left\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'left');
    git(repo, 'switch', '-c', 'work/right', 'main');
    writeFileSync(join(repo, 'conflict.txt'), 'right\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'right');
    try {
      git(repo, 'merge', 'work/left');
    } catch {
      /* the conflict is the point */
    }

    const tree = await inspectTree(ctx, repo, project(), true);
    expect(tree?.midOperation).toBe('merge');
    const result = await checkpointTree(ctx, tree!, options);
    expect(result.committed).toBe(false);
    expect(result.skipped).toBe('merge in progress');
  });

  it('refuses to commit on a detached HEAD', async () => {
    const head = git(repo, 'rev-parse', 'HEAD').trim();
    git(repo, 'checkout', head);
    writeFileSync(join(repo, 'detached.txt'), 'x\n');

    const tree = await inspectTree(ctx, repo, project(), true);
    const result = await checkpointTree(ctx, tree!, options);
    expect(result.skipped).toBe('detached HEAD');
  });

  it('commits but reports honestly when there is nowhere to push', async () => {
    const noRemote = join(root, 'lonely');
    mkdirSync(noRemote);
    git(noRemote, 'init', '-b', 'work/lonely');
    git(noRemote, 'config', 'user.name', 'Test');
    git(noRemote, 'config', 'user.email', 'test@example.com');
    writeFileSync(join(noRemote, 'a.txt'), 'a\n');

    const tree = await inspectTree(ctx, noRemote, projectSchema.parse({ path: noRemote }), true);
    const result = await checkpointTree(ctx, tree!, options);
    expect(result.committed).toBe(true);
    expect(result.pushed).toBe(false);
    expect(result.skipped).toBe('no remote configured');
  });

  it('changes nothing under --dry-run', async () => {
    git(repo, 'switch', '-c', 'work/dry');
    writeFileSync(join(repo, 'work.txt'), 'uncommitted\n');
    const before = git(repo, 'rev-parse', 'HEAD');

    const tree = await inspectTree(ctx, repo, project(), true);
    const result = await checkpointTree(ctx, tree!, { ...options, dryRun: true });
    expect(result.committed).toBe(false);
    expect(result.skipped).toContain('dry run');
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(before);
    expect(git(repo, 'status', '--porcelain')).toContain('work.txt');
  });

  it('honours a custom protectedBranches list', async () => {
    git(repo, 'switch', '-c', 'release/1.0');
    writeFileSync(join(repo, 'work.txt'), 'x\n');
    const tree = await inspectTree(
      ctx,
      repo,
      project({ protectedBranches: ['release/1.0'] }),
      true,
    );
    const result = await checkpointTree(ctx, tree!, options);
    expect(result.skipped).toContain('protected branch release/1.0');
  });
});

describe('checkpointTree — never force-pushes', () => {
  it('leaves a diverged remote alone and reports the failure', async () => {
    git(repo, 'switch', '-c', 'work/diverged');
    git(repo, 'push', '-u', 'origin', 'work/diverged');

    // Somebody else pushes to the same branch.
    const other = join(root, 'other');
    execFileSync('git', ['clone', remote, other]);
    git(other, 'config', 'user.name', 'Other');
    git(other, 'config', 'user.email', 'other@example.com');
    git(other, 'switch', 'work/diverged');
    writeFileSync(join(other, 'theirs.txt'), 'theirs\n');
    git(other, 'add', '-A');
    git(other, 'commit', '-m', 'theirs');
    git(other, 'push');

    // We have our own local commit, so the push cannot fast-forward.
    writeFileSync(join(repo, 'ours.txt'), 'ours\n');
    const tree = await inspectTree(ctx, repo, project(), true);
    const result = await checkpointTree(ctx, tree!, options);

    expect(result.committed).toBe(true);
    expect(result.pushed).toBe(false);
    expect(result.error).toContain('git push failed');
    // Their commit is untouched: nothing was overwritten.
    expect(git(remote, 'log', '--format=%s', 'work/diverged')).toContain('theirs');
  });
});

describe('discoverTrees', () => {
  it('finds the main tree and the worktrees the glob selects, and nothing else', async () => {
    const agentDir = join(repo, '.claude', 'worktrees');
    mkdirSync(agentDir, { recursive: true });
    git(repo, 'worktree', 'add', '-b', 'work/agent-1', join(agentDir, 'agent-1'));
    git(repo, 'worktree', 'add', '-b', 'work/elsewhere', join(root, 'elsewhere'));

    const trees = await discoverTrees(ctx, project());
    const paths = trees.map((t) => t.path);
    expect(paths).toContain(repo);
    expect(paths.some((p) => p.endsWith(`worktrees${sep}agent-1`))).toBe(true);
    expect(paths.some((p) => p.includes('elsewhere'))).toBe(false);
  });

  it('can be told to skip the main tree', async () => {
    const trees = await discoverTrees(ctx, project({ includeMainTree: false }));
    expect(trees.map((t) => t.path)).not.toContain(repo);
  });
});

describe('checkpointMessage', () => {
  it('names the trigger and the moment, so the commit explains itself', () => {
    expect(checkpointMessage(options)).toBe(
      'wip(rotorcc): auto-checkpoint test 2026-08-18T00:00:00Z',
    );
  });

  it('accepts a custom template', () => {
    expect(checkpointMessage({ ...options, messageTemplate: 'wip {{trigger}}' })).toBe('wip test');
  });
});
