/**
 * The manifest is the contract between a session that is ending and one that is
 * starting. If it does not round-trip, a rotation silently loses the plan.
 */
import { describe, expect, it } from 'vitest';

import {
  type Manifest,
  parseManifest,
  renderManifestMarkdown,
  treeToManifest,
} from '../src/core/manifest.js';
import type { CheckpointOutcome, TreeStatus } from '../src/core/worktrees.js';

const tree: TreeStatus = {
  path: '/home/dev/project/.claude/worktrees/agent-1',
  branch: 'work/feature-a',
  detached: false,
  protectedBranch: false,
  dirtyFiles: 3,
  ahead: 2,
  hasRemote: true,
  remote: 'origin',
  upstream: 'origin/work/feature-a',
  tip: 'abc1234 add the thing',
  midOperation: null,
  isMainTree: false,
};

const outcome: CheckpointOutcome = {
  tree: tree.path,
  branch: tree.branch,
  committed: true,
  pushed: true,
  skipped: null,
  error: null,
};

const manifest: Manifest = {
  schemaVersion: 1,
  id: '2026-08-18T01-23-45-678Z',
  createdAt: '2026-08-18T01:23:45.678Z',
  trigger: 'rotate',
  tool: { name: 'rotorcc', version: '0.1.0' },
  session: {
    id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    transcriptPath: '/home/dev/.claude/projects/-home-dev-project/session.jsonl',
    cwd: '/home/dev/project',
    backgroundTasks: [
      {
        id: 'a1',
        type: 'subagent',
        status: 'running',
        description: 'building the thing',
        agentType: 'general-purpose',
      },
    ],
    lastAssistantMessage: 'working on it',
  },
  accounts: {
    activeNumber: 1,
    targetNumber: 3,
    observedAt: '2026-08-18T01:23:40.000Z',
    list: [
      {
        number: 1,
        label: 'first',
        headroomPct: 4,
        bindingWindow: '5h',
        resetsAt: '2026-08-18T05:00:00Z',
        active: true,
      },
      {
        number: 3,
        label: 'third',
        headroomPct: 100,
        bindingWindow: '5h',
        resetsAt: null,
        active: false,
      },
    ],
  },
  projects: [
    {
      path: '/home/dev/project',
      trees: [treeToManifest(tree, outcome, ['notes/checkpoint-a.md'])],
      pullRequests: [
        {
          number: 12,
          title: 'Add the thing',
          branch: 'work/feature-a',
          url: 'https://example.com/12',
        },
      ],
    },
  ],
  snapshot: {
    storePath: '/home/dev/.local/share/rotorcc/store',
    commit: 'deadbeef',
    filesCopied: 4,
    bytesCopied: 2048,
    mirror: { attempted: true, ok: true, detail: 'rsync to backup:/srv/transcripts/' },
    secretHits: 0,
  },
  extras: [{ label: 'disk', output: '/dev/sda1  40% used' }],
  nextCommands: ['rotorcc status'],
  cleanExit: false,
};

describe('manifest schema', () => {
  it('round-trips through JSON without losing or changing anything', () => {
    const parsed = parseManifest(JSON.parse(JSON.stringify(manifest)));
    expect(parsed).toEqual(manifest);
  });

  it('rejects a manifest from a schema version it does not understand', () => {
    expect(() => parseManifest({ ...manifest, schemaVersion: 2 })).toThrow();
  });

  it('rejects a manifest missing the parts a resume depends on', () => {
    const { projects: _projects, ...withoutProjects } = manifest;
    expect(() => parseManifest(withoutProjects)).toThrow();
  });

  it('accepts a manifest written with no session attached', () => {
    const parsed = parseManifest({ ...manifest, session: null });
    expect(parsed.session).toBeNull();
  });

  it('defaults the optional collections rather than failing on their absence', () => {
    const trimmed = JSON.parse(JSON.stringify(manifest)) as Record<string, unknown>;
    delete trimmed.extras;
    delete trimmed.nextCommands;
    const parsed = parseManifest(trimmed);
    expect(parsed.extras).toEqual([]);
    expect(parsed.nextCommands).toEqual([]);
  });
});

describe('treeToManifest', () => {
  it('carries the git facts and the checkpoint result together', () => {
    const entry = treeToManifest(tree, outcome);
    expect(entry).toMatchObject({
      branch: 'work/feature-a',
      ahead: 2,
      dirtyFiles: 3,
      checkpoint: { committed: true, pushed: true },
    });
  });

  it('records a null checkpoint when the tree was only inspected', () => {
    expect(treeToManifest(tree, undefined).checkpoint).toBeNull();
  });
});

describe('renderManifestMarkdown', () => {
  const markdown = renderManifestMarkdown(manifest);

  it('leads with what to do, not with a data dump', () => {
    expect(markdown.indexOf('## Do this first')).toBeLessThan(markdown.indexOf('## Lanes'));
  });

  it('says plainly that the previous session did not end cleanly', () => {
    expect(markdown).toContain('did NOT end cleanly');
  });

  it('names every branch, its tip and its push state', () => {
    expect(markdown).toContain('work/feature-a');
    expect(markdown).toContain('abc1234 add the thing');
    expect(markdown).toContain('committed + pushed');
  });

  it('warns that background tasks do not survive the switch', () => {
    expect(markdown).toContain('building the thing');
    expect(markdown).toContain('Re-dispatch any that had not finished');
  });

  it('lists the resume notes it found', () => {
    expect(markdown).toContain('notes/checkpoint-a.md');
  });

  it('reports a refused mirror rather than hiding it', () => {
    const refused = renderManifestMarkdown({
      ...manifest,
      snapshot: {
        ...manifest.snapshot,
        secretHits: 2,
        mirror: { attempted: false, ok: false, detail: 'refused: secrets screen matched' },
      },
    });
    expect(refused).toContain('secrets screen matched 2 time(s)');
    expect(refused).toContain('mirror was refused');
  });

  it('says the previous session ended cleanly when it did', () => {
    expect(renderManifestMarkdown({ ...manifest, cleanExit: true })).toContain('ended cleanly');
  });
});
