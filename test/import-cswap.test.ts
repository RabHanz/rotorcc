/**
 * Importing accounts from claude-swap's store.
 *
 * The store layout in these fixtures is the real one, read off an installed
 * copy. The tests are mostly about partial failure, because that is the shape
 * of every defect rotorcc has had: one bad entry must cost one account, and an
 * account that comes across without a usable credential must be REPORTED as
 * skipped rather than left in the roster as a rotation target that fails at
 * the worst possible moment.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { CredentialStore } from '../src/accounts/credentials.js';
import { findCswapStore, importFromCswap } from '../src/accounts/importCswap.js';
import { RosterStore, slots } from '../src/accounts/roster.js';
import { cleanup, tempDir } from './helpers.js';

interface FixtureAccount {
  slot: number;
  email: string;
  alias?: string;
  credential?: string | null;
  identity?: boolean;
}

function credentialFor(email: string): string {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: `at-${email}`,
      refreshToken: `rt-${email}`,
      expiresAt: Date.now() + 3_600_000,
      scopes: ['user:inference'],
    },
  });
}

function buildCswapStore(root: string, accounts: FixtureAccount[]): string {
  const store = join(root, 'claude-swap');
  mkdirSync(join(store, 'credentials'), { recursive: true });
  mkdirSync(join(store, 'configs'), { recursive: true });

  const sequence: Record<string, unknown> = {};
  for (const account of accounts) {
    sequence[String(account.slot)] = {
      email: account.email,
      uuid: `uuid-${account.slot}`,
      organizationUuid: `org-${account.slot}`,
      organizationName: `Org ${account.slot}`,
      added: '2026-08-13T18:29:23Z',
      ...(account.alias === undefined ? {} : { alias: account.alias }),
    };

    if (account.credential !== null) {
      const raw = account.credential ?? credentialFor(account.email);
      writeFileSync(
        join(store, 'credentials', `.creds-${account.slot}-${account.email}.enc`),
        Buffer.from(raw, 'utf8').toString('base64'),
      );
    }
    if (account.identity !== false) {
      writeFileSync(
        join(store, 'configs', `.claude-config-${account.slot}-${account.email}.json`),
        JSON.stringify({
          oauthAccount: { emailAddress: account.email, accountUuid: `uuid-${account.slot}` },
          projects: { '/somewhere': { big: 'blob' } },
        }),
      );
    }
  }

  writeFileSync(
    join(store, 'sequence.json'),
    JSON.stringify({ activeAccountNumber: 3, sequence: [1, 2, 3], accounts: sequence }),
  );
  return store;
}

async function runImport(
  accounts: FixtureAccount[],
  options: { dryRun?: boolean; overwrite?: boolean; seed?: boolean } = {},
) {
  const root = tempDir('rotorcc-import-');
  const source = buildCswapStore(root, accounts);
  const accountsDir = join(root, 'rotorcc-accounts');
  const roster = new RosterStore(accountsDir);
  const credentials = new CredentialStore({ accountsDir, platform: 'linux' });

  if (options.seed === true) {
    roster.write({
      version: 1,
      activeSlot: null,
      lastUpdated: '',
      accounts: {
        '1': {
          email: 'existing@example.com',
          uuid: '',
          organizationUuid: '',
          organizationName: '',
          added: '',
          alias: '',
          disabled: false,
          kind: 'oauth',
        },
      },
    });
  }

  const report = await importFromCswap({
    roster,
    credentials,
    from: source,
    ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
    ...(options.overwrite === undefined ? {} : { overwrite: options.overwrite }),
  });
  return { report, roster, credentials, root, source };
}

describe('importFromCswap', () => {
  it('brings across every account with its credential and identity', async () => {
    const { report, roster, credentials, root } = await runImport([
      { slot: 1, email: 'one@example.com', alias: 'work' },
      { slot: 2, email: 'two@example.com' },
    ]);
    try {
      expect(report.imported.map((i) => i.slot)).toEqual([1, 2]);
      expect(slots(roster.read()).map((s) => s.email)).toEqual([
        'one@example.com',
        'two@example.com',
      ]);
      const stash = await credentials.readStash(1, 'one@example.com');
      expect(stash.kind).toBe('found');
      expect(stash.kind === 'found' && JSON.parse(stash.value).claudeAiOauth.refreshToken).toBe(
        'rt-one@example.com',
      );
      expect(credentials.readAccountIdentity(1, 'one@example.com')).toEqual({
        emailAddress: 'one@example.com',
        accountUuid: 'uuid-1',
      });
    } finally {
      cleanup(root);
    }
  });

  it('carries a valid alias across and drops one that would collide', async () => {
    const { report, roster, root } = await runImport(
      [
        { slot: 2, email: 'two@example.com', alias: 'work' },
        { slot: 3, email: 'three@example.com', alias: 'WORK' },
      ],
      {},
    );
    try {
      expect(report.imported.length).toBe(2);
      const aliases = slots(roster.read()).map((s) => s.alias);
      // Two slots answering to one name makes every later `switch work`
      // ambiguous, so the second is dropped rather than duplicated.
      expect(aliases.filter((a) => a === 'work').length).toBe(1);
    } finally {
      cleanup(root);
    }
  });

  it('SKIPS a slot whose credential is missing, rather than creating a stub', async () => {
    const { report, roster, root } = await runImport([
      { slot: 1, email: 'ok@example.com' },
      { slot: 2, email: 'broken@example.com', credential: null },
    ]);
    try {
      // A stub would sit in the roster looking like a rotation target and fail
      // every time it was chosen.
      expect(report.imported.map((i) => i.slot)).toEqual([1]);
      expect(report.skipped[0]?.slot).toBe(2);
      expect(report.skipped[0]?.reason).toContain('re-add this one by hand');
      expect(slots(roster.read()).map((s) => s.slot)).toEqual([1]);
    } finally {
      cleanup(root);
    }
  });

  it('SKIPS a slot whose credential file is corrupt, and keeps the others', async () => {
    const { report, root } = await runImport([
      { slot: 1, email: 'ok@example.com' },
      { slot: 2, email: 'corrupt@example.com', credential: 'not a credential at all' },
      { slot: 3, email: 'alsook@example.com' },
    ]);
    try {
      // One bad entry costs one account. This is the discipline that had to be
      // retrofitted after a single `"usage": null` blinded all three.
      expect(report.imported.map((i) => i.slot)).toEqual([1, 3]);
      expect(report.skipped.map((s) => s.slot)).toEqual([2]);
    } finally {
      cleanup(root);
    }
  });

  it("does NOT inherit the source's idea of which account is active", async () => {
    const { roster, root } = await runImport([
      { slot: 1, email: 'one@example.com' },
      { slot: 3, email: 'three@example.com' },
    ]);
    try {
      // rotorcc establishes the active account by fingerprinting the real
      // credential on the machine. Inheriting another tool's assertion is the
      // kind of unverified claim this project keeps getting bitten by.
      expect(roster.read().activeSlot).toBeNull();
    } finally {
      cleanup(root);
    }
  });

  it('leaves an existing rotorcc slot alone unless --overwrite is given', async () => {
    const { report, roster, root } = await runImport([{ slot: 1, email: 'incoming@example.com' }], {
      seed: true,
    });
    try {
      expect(report.alreadyPresent).toEqual([1]);
      expect(slots(roster.read())[0]?.email).toBe('existing@example.com');
    } finally {
      cleanup(root);
    }
  });

  it('replaces it when --overwrite is given', async () => {
    const { report, roster, root } = await runImport([{ slot: 1, email: 'incoming@example.com' }], {
      seed: true,
      overwrite: true,
    });
    try {
      expect(report.imported.map((i) => i.slot)).toEqual([1]);
      expect(slots(roster.read())[0]?.email).toBe('incoming@example.com');
    } finally {
      cleanup(root);
    }
  });

  it('writes nothing under a dry run but still reports what it would do', async () => {
    const { report, roster, credentials, root } = await runImport(
      [{ slot: 1, email: 'one@example.com' }],
      { dryRun: true },
    );
    try {
      expect(report.dryRun).toBe(true);
      expect(report.imported.map((i) => i.slot)).toEqual([1]);
      expect(slots(roster.read())).toEqual([]);
      expect((await credentials.readStash(1, 'one@example.com')).kind).toBe('absent');
    } finally {
      cleanup(root);
    }
  });

  it('does not modify the source store', async () => {
    const { root, source } = await runImport([{ slot: 1, email: 'one@example.com' }]);
    try {
      // An operator who imports and then prefers the old tool must find it
      // exactly as they left it.
      const sequence = JSON.parse(
        (await import('node:fs')).readFileSync(join(source, 'sequence.json'), 'utf8'),
      ) as { activeAccountNumber: number };
      expect(sequence.activeAccountNumber).toBe(3);
    } finally {
      cleanup(root);
    }
  });

  it('reports plainly when there is no source store to read', async () => {
    const root = tempDir('rotorcc-import-');
    try {
      const accountsDir = join(root, 'accounts');
      const report = await importFromCswap({
        roster: new RosterStore(accountsDir),
        credentials: new CredentialStore({ accountsDir, platform: 'linux' }),
        from: join(root, 'nothing-here'),
      });
      expect(report.imported).toEqual([]);
      // The message names the exact path it looked at, so the operator can see
      // whether it was the wrong directory or a genuinely absent store.
      expect(report.skipped[0]?.reason).toContain('sequence.json could not be read');
    } finally {
      cleanup(root);
    }
  });

  it('finds nothing rather than throwing when no store exists anywhere', () => {
    const root = tempDir('rotorcc-import-');
    try {
      expect(findCswapStore({}, root)).toBeNull();
    } finally {
      cleanup(root);
    }
  });
});
