import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { emptyState } from '../src/core/decide.js';
import { FLAG_ROTATE_NOW, Store, timestampSlug } from '../src/core/state.js';
import { cleanup, tempDir } from './helpers.js';

let dir: string;
let store: Store;

beforeEach(() => {
  dir = tempDir('rotorcc-state-');
  store = new Store(dir);
  store.ensure();
});

afterEach(() => cleanup(dir));

describe('state', () => {
  it('round-trips through disk', () => {
    const state = { ...emptyState(), lastSnapshotAt: '2026-08-18T00:00:00Z' };
    store.writeState(state);
    expect(store.readState()).toEqual(state);
  });

  it('falls back to an empty state rather than throwing on a corrupt file', () => {
    writeFileSync(join(dir, 'state.json'), '{ half-written');
    expect(store.readState()).toEqual(emptyState());
  });

  it('ignores a state file from a schema version it does not know', () => {
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ version: 99, latches: { warn: {} } }));
    expect(store.readState()).toEqual(emptyState());
  });
});

describe('flags', () => {
  it('raises, reads and clears', () => {
    expect(store.readFlag(FLAG_ROTATE_NOW)).toBeNull();
    store.raiseFlag(FLAG_ROTATE_NOW, { raisedAt: 'now', reason: 'because', targetAccount: 2 });
    expect(store.readFlag(FLAG_ROTATE_NOW)?.targetAccount).toBe(2);
    expect(store.clearFlag(FLAG_ROTATE_NOW)).toBe(true);
    expect(store.readFlag(FLAG_ROTATE_NOW)).toBeNull();
    expect(store.clearFlag(FLAG_ROTATE_NOW)).toBe(false);
  });
});

describe('locking', () => {
  it('excludes a second holder', () => {
    expect(store.acquireLock('tick')).toBe(true);
    expect(store.acquireLock('tick')).toBe(false);
    store.releaseLock('tick');
    expect(store.acquireLock('tick')).toBe(true);
  });

  it('breaks a lock whose owning process no longer exists', () => {
    // A pid that cannot be running: the kernel would have to have handed out
    // the maximum pid, and even then it is not this lock's owner.
    const lock = join(dir, 'locks', 'tick');
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, 'owner'), `4194304\n${new Date().toISOString()}\n`);
    expect(store.acquireLock('tick', 3600)).toBe(true);
  });

  it('respects a lock held by a process that is alive', () => {
    const lock = join(dir, 'locks', 'tick');
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, 'owner'), `${process.ppid}\n${new Date().toISOString()}\n`);
    expect(store.acquireLock('tick', 3600)).toBe(false);
  });

  it('breaks a lock older than the stale window even if the owner is unknown', () => {
    const lock = join(dir, 'locks', 'tick');
    mkdirSync(lock, { recursive: true });
    expect(store.acquireLock('tick', 0)).toBe(true);
  });

  it('does not deadlock on its own pid', () => {
    expect(store.acquireLock('tick')).toBe(true);
    expect(store.acquireLock('tick', 3600)).toBe(false);
  });
});

describe('manifests', () => {
  it('lists newest first', () => {
    store.writeAtomic(join('manifests', 'manifest-2026-01-01T00-00-00-000Z.json'), '{}');
    store.writeAtomic(join('manifests', 'manifest-2026-06-01T00-00-00-000Z.json'), '{}');
    const list = store.listManifests();
    expect(list[0]).toContain('2026-06-01');
    expect(store.latestManifest()).toBe(list[0]);
  });

  it('reports none when there are none', () => {
    expect(store.latestManifest()).toBeNull();
  });
});

describe('writeAtomic', () => {
  it('leaves no temp file behind', () => {
    const path = store.writeAtomic('thing.json', '{"a":1}');
    expect(existsSync(path)).toBe(true);
    expect(existsSync(`${path}.tmp-${process.pid}`)).toBe(false);
  });
});

describe('timestampSlug', () => {
  it('is sortable and legal as a filename on every platform', () => {
    const slug = timestampSlug(new Date('2026-08-18T01:23:45.678Z'));
    expect(slug).toBe('2026-08-18T01-23-45-678Z');
    expect(slug).not.toMatch(/[:\\/*?"<>|]/);
  });
});
