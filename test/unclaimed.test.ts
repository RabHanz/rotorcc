/**
 * Orphaned-credential recovery.
 *
 * The interesting cases are not "does it list files". They are:
 *
 *   - does a LIVE account's credential ever show up as an orphan (it must not —
 *     an operator who purged one of those would lose a working login), and
 *   - does purge delete exactly what it said it would and nothing beside it.
 *
 * Every fixture here is a real credential-shaped blob written through the real
 * `CredentialStore`, not a hand-placed file, so the layout under test is the one
 * the switch transaction actually produces.
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { CredentialStore, asSecret } from '../src/accounts/credentials.js';
import { RosterStore, emptyRoster } from '../src/accounts/roster.js';
import { findUnclaimed, parseStashName, purgeUnclaimed } from '../src/accounts/unclaimed.js';
import { cleanup, tempDir } from './helpers.js';

const dirs: string[] = [];

function accountsDir(): string {
  const dir = tempDir('rotorcc-unclaimed-');
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  cleanup(...dirs.splice(0));
});

/** A credential blob shaped like the real thing, with a distinguishable token. */
function credential(refresh: string, expiresAt = Date.now() + 3_600_000): string {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: `sk-ant-oat-${refresh}`,
      refreshToken: `sk-ant-ort-${refresh}`,
      expiresAt,
      scopes: ['user:inference'],
      subscriptionType: 'max',
    },
  });
}

async function seed(
  dir: string,
  entries: Array<{ slot: number; email: string; refresh: string; inRoster: boolean }>,
): Promise<void> {
  const credentials = new CredentialStore({ accountsDir: dir, platform: 'linux' });
  const roster = new RosterStore(dir);
  const table = emptyRoster();
  for (const entry of entries) {
    await credentials.writeStash(entry.slot, entry.email, asSecret(credential(entry.refresh)));
    if (entry.inRoster) {
      table.accounts[String(entry.slot)] = {
        email: entry.email,
        uuid: '',
        organizationUuid: '',
        organizationName: '',
        added: new Date().toISOString(),
        alias: '',
        disabled: false,
        kind: 'oauth',
      };
    }
  }
  roster.write(table);
}

describe('parseStashName', () => {
  it('splits a slot from the sanitised email', () => {
    expect(parseStashName('2-someone@example.com')).toEqual({
      slot: 2,
      emailFragment: 'someone@example.com',
    });
  });

  it('refuses a name with no slot number rather than guessing one', () => {
    expect(parseStashName('someone@example.com')).toBeNull();
    expect(parseStashName('')).toBeNull();
  });
});

describe('findUnclaimed', () => {
  it('finds nothing when every credential belongs to a roster entry', async () => {
    const dir = accountsDir();
    await seed(dir, [
      { slot: 1, email: 'one@example.com', refresh: 'one', inRoster: true },
      { slot: 2, email: 'two@example.com', refresh: 'two', inRoster: true },
    ]);
    expect(findUnclaimed(dir, new RosterStore(dir).read())).toEqual([]);
  });

  it('reports a credential whose slot is not in the roster at all', async () => {
    const dir = accountsDir();
    await seed(dir, [
      { slot: 1, email: 'one@example.com', refresh: 'one', inRoster: true },
      { slot: 7, email: 'ghost@example.com', refresh: 'ghost', inRoster: false },
    ]);

    const found = findUnclaimed(dir, new RosterStore(dir).read());
    expect(found).toHaveLength(1);
    expect(found[0]?.id).toBe('7-ghost@example.com');
    expect(found[0]?.slot).toBe(7);
    expect(found[0]?.email).toBe('ghost@example.com');
    expect(found[0]?.reason).toBe('slot-not-in-roster');
    expect(found[0]?.detail).toContain('no account occupies slot 7');
  });

  it('reports a credential whose slot now holds a different login', async () => {
    const dir = accountsDir();
    await seed(dir, [
      { slot: 1, email: 'current@example.com', refresh: 'current', inRoster: true },
      { slot: 1, email: 'previous@example.com', refresh: 'previous', inRoster: false },
    ]);

    const found = findUnclaimed(dir, new RosterStore(dir).read());
    expect(found).toHaveLength(1);
    expect(found[0]?.id).toBe('1-previous@example.com');
    expect(found[0]?.reason).toBe('slot-holds-another-account');
    expect(found[0]?.detail).toContain('current@example.com');
  });

  it('carries enough identity to decide with, and no credential', async () => {
    const dir = accountsDir();
    await seed(dir, [
      { slot: 3, email: 'orphan@example.com', refresh: 'secret-value', inRoster: false },
    ]);

    const entry = findUnclaimed(dir, new RosterStore(dir).read())[0];
    expect(entry).toBeDefined();
    expect(entry?.fingerprint).toMatch(/^rt:[0-9a-f]{12}$/);
    expect(entry?.kind).toBe('oauth');
    expect(entry?.ageMs).not.toBeNull();
    expect(entry?.modifiedAt).not.toBeNull();
    expect(entry?.bytes).toBeGreaterThan(0);

    // The whole record, serialised, must not contain the token in any form.
    const serialised = JSON.stringify(entry);
    expect(serialised).not.toContain('secret-value');
    expect(serialised).not.toContain('sk-ant');
  });

  it('reports a retained previous generation whose current copy is gone', async () => {
    const dir = accountsDir();
    const credentials = new CredentialStore({ accountsDir: dir, platform: 'linux' });
    // Two writes make a `.prev`; deleting the current file leaves only that.
    await credentials.writeStash(4, 'gone@example.com', asSecret(credential('first')));
    await credentials.writeStash(4, 'gone@example.com', asSecret(credential('second')));
    new RosterStore(dir).write(emptyRoster());

    const credDir = join(dir, 'credentials');
    const current = readdirSync(credDir).find((n) => n.endsWith('.cred'));
    expect(current).toBeDefined();
    const { unlinkSync } = await import('node:fs');
    unlinkSync(join(credDir, current as string));

    const found = findUnclaimed(dir, new RosterStore(dir).read());
    expect(found).toHaveLength(1);
    expect(found[0]?.reason).toBe('retained-previous-generation');
    expect(found[0]?.detail).toContain('previous generation');
  });

  it('reports an identity file left behind with no credential', async () => {
    const dir = accountsDir();
    const credentials = new CredentialStore({ accountsDir: dir, platform: 'linux' });
    credentials.writeAccountIdentity(9, 'stray@example.com', {
      emailAddress: 'stray@example.com',
    });
    new RosterStore(dir).write(emptyRoster());

    const found = findUnclaimed(dir, new RosterStore(dir).read());
    expect(found).toHaveLength(1);
    expect(found[0]?.reason).toBe('identity-without-credential');
    expect(found[0]?.kind).toBe('not-a-credential');
    // The sidecar carries the real address, so it beats the filename fragment.
    expect(found[0]?.emailIsExact).toBe(true);
    expect(found[0]?.email).toBe('stray@example.com');
  });

  it('is empty when there is no credential directory at all', () => {
    const dir = accountsDir();
    expect(findUnclaimed(dir, emptyRoster())).toEqual([]);
  });

  it('ignores files that are not credential-store files', async () => {
    const dir = accountsDir();
    await seed(dir, [{ slot: 1, email: 'one@example.com', refresh: 'one', inRoster: true }]);
    mkdirSync(join(dir, 'credentials'), { recursive: true });
    writeFileSync(join(dir, 'credentials', 'README.txt'), 'not ours');
    expect(findUnclaimed(dir, new RosterStore(dir).read())).toEqual([]);
  });
});

describe('purgeUnclaimed', () => {
  it('deletes every file of one orphan and leaves the live account alone', async () => {
    const dir = accountsDir();
    await seed(dir, [
      { slot: 1, email: 'live@example.com', refresh: 'live', inRoster: true },
      { slot: 5, email: 'orphan@example.com', refresh: 'orphan', inRoster: false },
    ]);
    const credentials = new CredentialStore({ accountsDir: dir, platform: 'linux' });
    credentials.writeAccountIdentity(5, 'orphan@example.com', {
      emailAddress: 'orphan@example.com',
    });

    const roster = new RosterStore(dir).read();
    const before = findUnclaimed(dir, roster);
    expect(before).toHaveLength(1);
    const files = before[0]?.files ?? [];
    expect(files.length).toBeGreaterThanOrEqual(2);

    const result = purgeUnclaimed(dir, roster, '5-orphan@example.com');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.removed.sort()).toEqual([...files].sort());
    for (const file of files) expect(existsSync(file)).toBe(false);

    // The live account is untouched and still readable.
    const live = await credentials.readStash(1, 'live@example.com');
    expect(live.kind).toBe('found');
    expect(findUnclaimed(dir, roster)).toEqual([]);
  });

  it('refuses an id that matches nothing rather than deleting something near it', async () => {
    const dir = accountsDir();
    await seed(dir, [{ slot: 5, email: 'orphan@example.com', refresh: 'o', inRoster: false }]);
    const roster = new RosterStore(dir).read();

    for (const wrong of ['5', 'orphan@example.com', '5-orphan', '', '*']) {
      const result = purgeUnclaimed(dir, roster, wrong);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('no-such-id');
    }
    // Nothing was deleted by any of those.
    expect(findUnclaimed(dir, roster)).toHaveLength(1);
  });

  it('refuses to purge a credential the roster still claims', async () => {
    const dir = accountsDir();
    await seed(dir, [{ slot: 1, email: 'live@example.com', refresh: 'live', inRoster: true }]);
    const roster = new RosterStore(dir).read();

    const result = purgeUnclaimed(dir, roster, '1-live@example.com');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('claimed');
      expect(result.detail).toContain('accounts remove');
    }
    const credentials = new CredentialStore({ accountsDir: dir, platform: 'linux' });
    expect((await credentials.readStash(1, 'live@example.com')).kind).toBe('found');
  });

  it('re-derives the orphan list at purge time, so a re-claimed slot is safe', async () => {
    const dir = accountsDir();
    await seed(dir, [{ slot: 2, email: 'back@example.com', refresh: 'b', inRoster: false }]);

    // An operator lists the orphans, then re-adds that account before purging.
    const stale = findUnclaimed(dir, new RosterStore(dir).read());
    expect(stale).toHaveLength(1);

    const store = new RosterStore(dir);
    store.update((r) => {
      r.accounts['2'] = {
        email: 'back@example.com',
        uuid: '',
        organizationUuid: '',
        organizationName: '',
        added: new Date().toISOString(),
        alias: '',
        disabled: false,
        kind: 'oauth',
      };
    });

    const result = purgeUnclaimed(dir, store.read(), '2-back@example.com');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('claimed');
    const credentials = new CredentialStore({ accountsDir: dir, platform: 'linux' });
    expect((await credentials.readStash(2, 'back@example.com')).kind).toBe('found');
  });
});
