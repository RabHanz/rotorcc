/**
 * The account storage layer: atomic writes, the roster, mappings.
 *
 * These are the files that hold credentials, so the tests are about the
 * properties that keep them safe rather than about the happy path: the mode
 * bits, the atomicity, the refusal to overwrite something unreadable.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ensurePrivateDir, writeFileAtomic, writeJsonAtomic } from '../src/accounts/atomic.js';
import { MappingStore, canonical, isWithin } from '../src/accounts/mappings.js';
import {
  RosterStore,
  emptyRoster,
  nextFreeSlot,
  normaliseAlias,
  resolveIdentifier,
  slots,
  swapSlots,
} from '../src/accounts/roster.js';
import { cleanup, tempDir } from './helpers.js';

function withTemp<T>(body: (dir: string) => T): T {
  const dir = tempDir('rotorcc-accounts-');
  try {
    return body(dir);
  } finally {
    cleanup(dir);
  }
}

describe('writeFileAtomic', () => {
  it('creates the file 0600, never briefly wider', () => {
    withTemp((dir) => {
      const target = join(dir, 'nested', 'secret.json');
      writeFileAtomic(target, 'sensitive');
      expect(readFileSync(target, 'utf8')).toBe('sensitive');
      if (process.platform !== 'win32') {
        expect(statSync(target).mode & 0o777).toBe(0o600);
        // The parent has to be tight too: a 0600 file inside a 0755 directory
        // still tells everyone on the box that the account exists.
        expect(statSync(join(dir, 'nested')).mode & 0o777).toBe(0o700);
      }
    });
  });

  it('replaces an existing file without a window where it is empty', () => {
    withTemp((dir) => {
      const target = join(dir, 'roster.json');
      writeFileAtomic(target, 'first');
      writeFileAtomic(target, 'second');
      expect(readFileSync(target, 'utf8')).toBe('second');
    });
  });

  it('leaves no temp file behind on success', () => {
    withTemp((dir) => {
      writeJsonAtomic(join(dir, 'a.json'), { a: 1 });
      const leftovers = readdirSync(dir).filter((f) => f.includes('.tmp'));
      expect(leftovers).toEqual([]);
    });
  });

  it('leaves no readable fragment behind when the rename fails', () => {
    withTemp((dir) => {
      // Renaming onto a directory fails on every platform.
      const target = join(dir, 'occupied');
      mkdirSync(target, { recursive: true });
      mkdirSync(join(target, 'child'), { recursive: true });
      expect(() => writeFileAtomic(target, 'a credential')).toThrow();
      const leftovers = readdirSync(dir).filter((f) => f.includes('.tmp'));
      expect(leftovers).toEqual([]);
    });
  });
});

describe('ensurePrivateDir', () => {
  it('is 0700 even when the umask is loose', () => {
    withTemp((dir) => {
      const nested = join(dir, 'a', 'b', 'c');
      ensurePrivateDir(nested);
      if (process.platform !== 'win32') {
        expect(statSync(nested).mode & 0o777).toBe(0o700);
      }
    });
  });
});

describe('roster', () => {
  it('treats a missing file as an empty roster, not an error', () => {
    withTemp((dir) => {
      expect(slots(new RosterStore(dir).read())).toEqual([]);
    });
  });

  it('REFUSES to read a roster that exists but does not parse', () => {
    withTemp((dir) => {
      // The important half. Returning "no accounts" for a torn roster is how
      // the next write erases three real accounts.
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'roster.json'), '{ this is not json');
      expect(() => new RosterStore(dir).read()).toThrow(/will not overwrite it/);
    });
  });

  it('round-trips slots and keeps them in numeric order, not JSON key order', () => {
    withTemp((dir) => {
      const store = new RosterStore(dir);
      const roster = emptyRoster();
      for (const n of [10, 2, 1]) {
        roster.accounts[String(n)] = {
          email: `a${n}@example.com`,
          uuid: '',
          organizationUuid: '',
          organizationName: '',
          added: '',
          alias: '',
          disabled: false,
          kind: 'oauth',
        };
      }
      store.write(roster);
      expect(slots(store.read()).map((s) => s.slot)).toEqual([1, 2, 10]);
    });
  });

  it('never renumbers surviving slots when one is removed', () => {
    withTemp((dir) => {
      const store = new RosterStore(dir);
      const roster = emptyRoster();
      for (const n of [1, 2, 3]) {
        roster.accounts[String(n)] = {
          email: `a${n}@example.com`,
          uuid: '',
          organizationUuid: '',
          organizationName: '',
          added: '',
          alias: '',
          disabled: false,
          kind: 'oauth',
        };
      }
      store.write(roster);
      store.update((r) => {
        delete r.accounts['2'];
      });
      // Slot 3 stays slot 3. A number that shifts under you is a number you
      // cannot put in a script or a directory mapping.
      expect(slots(store.read()).map((s) => s.slot)).toEqual([1, 3]);
      expect(nextFreeSlot(store.read())).toBe(2);
    });
  });
});

describe('alias rules', () => {
  it('rejects an all-digit alias, which could not be told from a slot number', () => {
    expect(() => normaliseAlias('12')).toThrow(/slot number/);
  });

  it('rejects an alias starting with a dash, which the CLI would read as a flag', () => {
    expect(() => normaliseAlias('-work')).toThrow(/flag/);
  });

  it('lowercases, so "Work" and "work" are the same handle', () => {
    expect(normaliseAlias('Work')).toBe('work');
  });

  it('rejects characters that would need quoting', () => {
    expect(() => normaliseAlias('my alias')).toThrow();
    expect(() => normaliseAlias('a/b')).toThrow();
  });
});

describe('resolveIdentifier', () => {
  const roster = emptyRoster();
  for (const [slot, email, alias] of [
    [1, 'one@example.com', 'work'],
    [2, 'two@example.com', ''],
    [3, 'two@example.com', ''],
  ] as const) {
    roster.accounts[String(slot)] = {
      email,
      uuid: '',
      organizationUuid: '',
      organizationName: '',
      added: '',
      alias,
      disabled: false,
      kind: 'oauth',
    };
  }

  it('finds by slot number', () => {
    const found = resolveIdentifier(roster, '1');
    expect(found.kind).toBe('found');
  });

  it('finds by alias, case-insensitively', () => {
    const found = resolveIdentifier(roster, 'WORK');
    expect(found.kind === 'found' && found.slot.slot).toBe(1);
  });

  it('reports ambiguity rather than picking one', () => {
    // Two slots sharing an email is a real state, and guessing means a switch
    // lands somewhere the operator did not choose.
    const found = resolveIdentifier(roster, 'two@example.com');
    expect(found.kind).toBe('ambiguous');
  });

  it('reports not-found rather than defaulting to the first slot', () => {
    expect(resolveIdentifier(roster, 'nobody@example.com').kind).toBe('not-found');
  });
});

describe('swapSlots', () => {
  it('follows the active slot across the swap', () => {
    const roster = emptyRoster();
    for (const n of [1, 2]) {
      roster.accounts[String(n)] = {
        email: `a${n}@example.com`,
        uuid: '',
        organizationUuid: '',
        organizationName: '',
        added: '',
        alias: '',
        disabled: false,
        kind: 'oauth',
      };
    }
    roster.activeSlot = 1;
    swapSlots(roster, 1, 2);
    expect(roster.accounts['2']?.email).toBe('a1@example.com');
    expect(roster.activeSlot).toBe(2);
  });

  it('refuses to swap with an empty slot instead of inventing one', () => {
    const roster = emptyRoster();
    roster.accounts['1'] = {
      email: 'a@example.com',
      uuid: '',
      organizationUuid: '',
      organizationName: '',
      added: '',
      alias: '',
      disabled: false,
      kind: 'oauth',
    };
    expect(() => swapSlots(roster, 1, 2)).toThrow(/empty/);
  });
});

describe('directory mappings', () => {
  it('returns null for an unmapped directory rather than a default account', () => {
    withTemp((dir) => {
      expect(new MappingStore(dir).resolve('/somewhere/else')).toBeNull();
    });
  });

  it('longest prefix wins, so a child mapping overrides its parent', () => {
    withTemp((dir) => {
      const store = new MappingStore(dir);
      store.set('/work', 1);
      store.set('/work/client-b', 2);
      expect(store.resolve('/work/other/repo')?.slot).toBe(1);
      expect(store.resolve('/work/client-b/repo')?.slot).toBe(2);
    });
  });

  it('does not let a sibling with a shared prefix inherit the mapping', () => {
    // `/home/u/proj-old` must not match a mapping on `/home/u/proj`.
    expect(isWithin('/home/u/proj-old', '/home/u/proj')).toBe(false);
    expect(isWithin('/home/u/proj/sub', '/home/u/proj')).toBe(true);
    expect(isWithin('/home/u/proj', '/home/u/proj')).toBe(true);
  });

  it('canonicalises a path that does not exist yet rather than throwing', () => {
    expect(canonical('/definitely/not/here/at/all')).toBe('/definitely/not/here/at/all');
  });

  it('unset reports whether there was anything to remove', () => {
    withTemp((dir) => {
      const store = new MappingStore(dir);
      store.set('/work', 1);
      expect(store.unset('/work')).toBe(true);
      expect(store.unset('/work')).toBe(false);
    });
  });
});

describe('mapping store durability', () => {
  it('treats an unparseable mapping file as empty rather than refusing to run', () => {
    withTemp((dir) => {
      // Unlike the roster, this is derived convenience data: losing it costs a
      // binding, not an account, so failing closed here would be the tool
      // refusing to work over something that does not matter.
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'mappings.json'), 'not json');
      expect(new MappingStore(dir).list()).toEqual([]);
    });
  });
});

describe('permissions on an existing store', () => {
  it('rewrites an over-permissive file back to 0600', () => {
    if (process.platform === 'win32') return;
    withTemp((dir) => {
      const target = join(dir, 'creds');
      writeFileAtomic(target, 'a');
      chmodSync(target, 0o644);
      writeFileAtomic(target, 'b');
      expect(statSync(target).mode & 0o777).toBe(0o600);
      expect(existsSync(target)).toBe(true);
    });
  });
});
