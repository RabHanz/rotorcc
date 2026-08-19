/**
 * The credential store and the switch transaction.
 *
 * The most dangerous code in rotorcc, so the tests are about the ways it could
 * destroy a login rather than the way it works:
 *
 *   - "unreadable" must never collapse into "absent", because a caller that
 *     believes a slot is empty will overwrite it;
 *   - a degraded read must never be captured over a good stash, because those
 *     bytes may hold an already-spent refresh token;
 *   - a failed switch must be rolled back, and a failed rollback must be
 *     reported rather than swallowed;
 *   - Claude Code's global config must never be overwritten when it exists but
 *     could not be parsed — that file holds every project and MCP server on
 *     the machine.
 *
 * Everything runs against a temp HOME with `platform: 'linux'` so the macOS
 * keychain paths are not exercised on a box that has no keychain.
 */
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  CredentialStore,
  asSecret,
  classifyCredential,
  composeForActivation,
  credentialFingerprint,
  looksLikeApiKey,
  machineSharedFields,
  safeFileFragment,
} from '../src/accounts/credentials.js';
import { RosterStore } from '../src/accounts/roster.js';
import { switchAccount } from '../src/accounts/switch.js';
import { cleanup, tempDir } from './helpers.js';

interface Harness {
  root: string;
  /**
   * The environment the harness's Claude home is described by.
   *
   * Threaded into every `switchAccount` call below, and that is not cosmetic:
   * the switch holds Claude Code's own credential AND config locks, and both
   * have to resolve against this temp home. Left to default, the tests would
   * take locks in the developer's real `~/.claude` while mutating files here.
   */
  claudeEnv: NodeJS.ProcessEnv;
  credentials: CredentialStore;
  roster: RosterStore;
  accountsDir: string;
  claudeHome: string;
}

function harness(): Harness {
  const root = tempDir('rotorcc-cred-');
  const claudeHome = join(root, 'claude');
  mkdirSync(claudeHome, { recursive: true });
  // CLAUDE_CONFIG_DIR set means the global config lives inside it, which is
  // Claude Code's own rule and the one rotorcc has to match exactly.
  const claudeEnv: NodeJS.ProcessEnv = { CLAUDE_CONFIG_DIR: claudeHome };
  const accountsDir = join(root, 'accounts');
  return {
    root,
    claudeEnv,
    claudeHome,
    accountsDir,
    credentials: new CredentialStore({ accountsDir, env: claudeEnv, platform: 'linux' }),
    roster: new RosterStore(accountsDir),
  };
}

/** Every switch in these tests goes through here, so none can forget the env. */
function doSwitch(h: Harness, target: unknown, dryRun = false) {
  return switchAccount({
    roster: h.roster,
    credentials: h.credentials,
    target: target as never,
    dryRun,
    env: h.claudeEnv,
  });
}

function oauth(tag: string): string {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: `at-${tag}`,
      refreshToken: `rt-${tag}`,
      expiresAt: Date.now() + 3_600_000,
    },
  });
}

function seedSlot(h: Harness, slot: number, email: string, tag = email): Promise<void> {
  h.roster.update((r) => {
    r.accounts[String(slot)] = {
      email,
      uuid: '',
      organizationUuid: '',
      organizationName: '',
      added: '',
      alias: '',
      disabled: false,
      kind: 'oauth',
    };
  });
  h.credentials.writeAccountIdentity(slot, email, { emailAddress: email });
  return h.credentials.writeStash(slot, email, asSecret(oauth(tag)));
}

describe('credential classification', () => {
  it('recognises a managed API key by its prefix and by not being JSON', () => {
    expect(looksLikeApiKey('sk-ant-api03-abc')).toBe(true);
    expect(looksLikeApiKey('{"claudeAiOauth":{}}')).toBe(false);
    // A setup token must never be filed as an API key: that routes it down a
    // path that clears the OAuth axis.
    expect(looksLikeApiKey('sk-ant-oat01-abc')).toBe(false);
  });

  it('classifies the three shapes it can be handed', () => {
    expect(classifyCredential('sk-ant-api03-x')).toBe('api-key');
    expect(classifyCredential(oauth('a'))).toBe('oauth');
    expect(classifyCredential('garbage')).toBe('unknown');
  });
});

describe('credentialFingerprint', () => {
  it('is stable across an access-token rotation', () => {
    const before = JSON.stringify({ claudeAiOauth: { accessToken: 'a1', refreshToken: 'r' } });
    const after = JSON.stringify({ claudeAiOauth: { accessToken: 'a2', refreshToken: 'r' } });
    // Two generations of one login must compare equal — that is the question
    // every caller is actually asking.
    expect(credentialFingerprint(before)).toBe(credentialFingerprint(after));
  });

  it('differs between two different logins', () => {
    expect(credentialFingerprint(oauth('a'))).not.toBe(credentialFingerprint(oauth('b')));
  });

  it('never contains the token itself', () => {
    const fingerprint = credentialFingerprint(oauth('supersecret')) ?? '';
    expect(fingerprint).not.toContain('supersecret');
    expect(fingerprint).not.toContain('rt-');
  });
});

describe('machine-shared fields', () => {
  it("splices the live machine's MCP state into the account being activated", () => {
    const target = JSON.stringify({ claudeAiOauth: { accessToken: 'a' }, mcpOAuth: { old: true } });
    const live = JSON.stringify({
      claudeAiOauth: { accessToken: 'b' },
      mcpOAuth: { current: true },
    });
    const composed = JSON.parse(composeForActivation(asSecret(target), live)) as Record<
      string,
      unknown
    >;
    expect(composed.mcpOAuth).toEqual({ current: true });
    expect((composed.claudeAiOauth as { accessToken: string }).accessToken).toBe('a');
  });

  it('does not resurrect a shared key the machine no longer holds', () => {
    const target = JSON.stringify({ claudeAiOauth: { accessToken: 'a' }, mcpOAuth: { old: true } });
    const live = JSON.stringify({ claudeAiOauth: { accessToken: 'b' } });
    const composed = JSON.parse(composeForActivation(asSecret(target), live)) as Record<
      string,
      unknown
    >;
    expect(composed.mcpOAuth).toBeUndefined();
  });

  it('keeps account-scoped siblings with the slot they belong to', () => {
    const target = JSON.stringify({
      claudeAiOauth: { accessToken: 'a' },
      trustedDeviceToken: 'target-device',
    });
    const live = JSON.stringify({
      claudeAiOauth: { accessToken: 'b' },
      trustedDeviceToken: 'live-device',
    });
    const composed = JSON.parse(composeForActivation(asSecret(target), live)) as Record<
      string,
      unknown
    >;
    // Carrying a live account-bound field across a switch would present one
    // account's credential under another's identity.
    expect(composed.trustedDeviceToken).toBe('target-device');
  });

  it('passes an API key through untouched', () => {
    expect(composeForActivation(asSecret('sk-ant-api03-x'), oauth('a'))).toBe('sk-ant-api03-x');
  });

  it('returns null for something that is not a credential object', () => {
    expect(machineSharedFields('not json')).toBeNull();
  });
});

describe('active credential', () => {
  it('reports absent when there is genuinely nothing anywhere', async () => {
    const h = harness();
    try {
      expect((await h.credentials.readActive()).kind).toBe('absent');
    } finally {
      cleanup(h.root);
    }
  });

  it('reports unreadable — NOT absent — when the file exists but cannot be read', async () => {
    const h = harness();
    try {
      // A directory where the credentials file should be: exists, unreadable.
      mkdirSync(join(h.claudeHome, '.credentials.json'), { recursive: true });
      const active = await h.credentials.readActive();
      // "absent" here would send the operator to a re-login that cannot help,
      // and would let a caller conclude the slot is empty and overwrite it.
      expect(active.kind).toBe('unreadable');
    } finally {
      cleanup(h.root);
    }
  });

  it('round-trips a written credential at 0600', async () => {
    const h = harness();
    try {
      await h.credentials.writeActive(asSecret(oauth('live')));
      const active = await h.credentials.readActive();
      expect(active.kind === 'found' && JSON.parse(active.value).claudeAiOauth.accessToken).toBe(
        'at-live',
      );
      if (process.platform !== 'win32') {
        expect(statSync(join(h.claudeHome, '.credentials.json')).mode & 0o777).toBe(0o600);
      }
    } finally {
      cleanup(h.root);
    }
  });
});

describe('global config', () => {
  it('preserves every key it does not own', () => {
    const h = harness();
    try {
      const path = join(h.claudeHome, '.claude.json');
      writeFileSync(
        path,
        JSON.stringify({
          oauthAccount: { emailAddress: 'a@x' },
          projects: { p: 1 },
          mcpServers: {},
        }),
      );
      h.credentials.updateGlobalConfig((config) => {
        config.oauthAccount = { emailAddress: 'b@x' };
      });
      const after = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      expect(after.projects).toEqual({ p: 1 });
      expect(after.mcpServers).toEqual({});
      expect(after.oauthAccount).toEqual({ emailAddress: 'b@x' });
    } finally {
      cleanup(h.root);
    }
  });

  it('REFUSES to overwrite a config that exists but cannot be parsed', () => {
    const h = harness();
    try {
      const path = join(h.claudeHome, '.claude.json');
      // A torn config — a valid prefix and a truncated tail, which is what a
      // crash mid-write leaves. `?? {}` here writes an empty object over the
      // file holding every project and MCP server on the machine.
      writeFileSync(path, '{"oauthAccount": {"emailAddress": "a@x"}, "projects": {"p":');
      expect(() =>
        h.credentials.updateGlobalConfig((config) => {
          config.oauthAccount = { emailAddress: 'b@x' };
        }),
      ).toThrow(/refusing to overwrite/);
      expect(readFileSync(path, 'utf8')).toContain('"projects"');
    } finally {
      cleanup(h.root);
    }
  });

  it('writes a fresh config when there genuinely is not one', () => {
    const h = harness();
    try {
      h.credentials.updateGlobalConfig((config) => {
        config.oauthAccount = { emailAddress: 'new@x' };
      });
      const after = JSON.parse(readFileSync(join(h.claudeHome, '.claude.json'), 'utf8')) as Record<
        string,
        unknown
      >;
      expect(after.oauthAccount).toEqual({ emailAddress: 'new@x' });
    } finally {
      cleanup(h.root);
    }
  });
});

describe('the stash', () => {
  it('retains exactly one previous generation as a recovery cushion', async () => {
    const h = harness();
    try {
      await h.credentials.writeStash(1, 'a@x', asSecret(oauth('gen1')));
      await h.credentials.writeStash(1, 'a@x', asSecret(oauth('gen2')));
      const previous = h.credentials.readPreviousStash(1, 'a@x');
      expect(previous).not.toBeNull();
      expect(JSON.parse(previous ?? '{}').claudeAiOauth.refreshToken).toBe('rt-gen1');
    } finally {
      cleanup(h.root);
    }
  });

  it('keys the stash by slot AND email, so a re-pointed slot cannot read the old occupant', async () => {
    const h = harness();
    try {
      await h.credentials.writeStash(1, 'first@x', asSecret(oauth('first')));
      expect((await h.credentials.readStash(1, 'second@x')).kind).toBe('absent');
    } finally {
      cleanup(h.root);
    }
  });

  it('is not stored in plaintext that a careless grep would match', async () => {
    const h = harness();
    try {
      await h.credentials.writeStash(1, 'a@x', asSecret('sk-ant-api03-verysecret'));
      const onDisk = readFileSync(
        join(h.accountsDir, 'credentials', `1-${safeFileFragment('a@x')}.cred`),
        'utf8',
      );
      // Encoding, not encryption — the mode is what protects it. But it does
      // stop a credential being matched by `grep -r sk-ant` and pasted into a
      // bug report.
      expect(onDisk).not.toContain('sk-ant-api03-verysecret');
    } finally {
      cleanup(h.root);
    }
  });

  it('makes an email safe as a filename on every platform', () => {
    expect(safeFileFragment('a/b:c@x')).toBe('a_b_c@x');
    expect(safeFileFragment('..')).toBe('_');
  });
});

describe('switchAccount', () => {
  it('captures the account being left before activating the new one', async () => {
    const h = harness();
    try {
      await seedSlot(h, 1, 'one@x');
      await seedSlot(h, 2, 'two@x');
      // The live credential is slot 1's, but Claude Code has since rotated it.
      const rotated = JSON.stringify({
        claudeAiOauth: { accessToken: 'at-rotated', refreshToken: 'rt-one@x' },
      });
      await h.credentials.writeActive(asSecret(rotated));

      const target = { ...h.roster.read().accounts['2'], slot: 2 } as never;
      const result = await doSwitch(h, target);

      expect(result.ok).toBe(true);
      expect(result.fromSlot).toBe(1);
      // Without the capture, slot 1 would still hold the pre-rotation copy —
      // an account that looks fine until the first time it is needed.
      const stash = await h.credentials.readStash(1, 'one@x');
      expect(stash.kind === 'found' && JSON.parse(stash.value).claudeAiOauth.accessToken).toBe(
        'at-rotated',
      );
    } finally {
      cleanup(h.root);
    }
  });

  it('activates the target and records it', async () => {
    const h = harness();
    try {
      await seedSlot(h, 1, 'one@x');
      await seedSlot(h, 2, 'two@x');
      await h.credentials.writeActive(asSecret(oauth('one@x')));

      const target = { ...h.roster.read().accounts['2'], slot: 2 } as never;
      const result = await doSwitch(h, target);

      expect(result.ok).toBe(true);
      const active = await h.credentials.readActive();
      expect(active.kind === 'found' && JSON.parse(active.value).claudeAiOauth.refreshToken).toBe(
        'rt-two@x',
      );
      expect(h.roster.read().activeSlot).toBe(2);
    } finally {
      cleanup(h.root);
    }
  });

  it('refuses when the target has no stored credential, BEFORE touching the live one', async () => {
    const h = harness();
    try {
      await seedSlot(h, 1, 'one@x');
      h.roster.update((r) => {
        r.accounts['2'] = {
          email: 'two@x',
          uuid: '',
          organizationUuid: '',
          organizationName: '',
          added: '',
          alias: '',
          disabled: false,
          kind: 'oauth',
        };
      });
      await h.credentials.writeActive(asSecret(oauth('one@x')));

      const target = { ...h.roster.read().accounts['2'], slot: 2 } as never;
      const result = await doSwitch(h, target);

      expect(result.ok).toBe(false);
      expect(result.detail).toContain('holds no credential');
      // Discovering this after clearing the live credential would leave the
      // machine with no login at all.
      const active = await h.credentials.readActive();
      expect(active.kind === 'found' && JSON.parse(active.value).claudeAiOauth.refreshToken).toBe(
        'rt-one@x',
      );
    } finally {
      cleanup(h.root);
    }
  });

  it('warns, and does not capture, when the live login is not one rotorcc manages', async () => {
    const h = harness();
    try {
      await seedSlot(h, 1, 'one@x');
      await seedSlot(h, 2, 'two@x');
      await h.credentials.writeActive(asSecret(oauth('a-stranger')));

      const target = { ...h.roster.read().accounts['2'], slot: 2 } as never;
      const result = await doSwitch(h, target);

      expect(result.ok).toBe(true);
      expect(result.fromSlot).toBeNull();
      expect(result.warnings.join(' ')).toContain('does not belong to any account rotorcc manages');
      // Slot 1's stored credential must be untouched by a switch away from
      // somebody else's login.
      const stash = await h.credentials.readStash(1, 'one@x');
      expect(stash.kind === 'found' && JSON.parse(stash.value).claudeAiOauth.refreshToken).toBe(
        'rt-one@x',
      );
    } finally {
      cleanup(h.root);
    }
  });

  it('changes nothing under a dry run and says so unmistakably', async () => {
    const h = harness();
    try {
      await seedSlot(h, 1, 'one@x');
      await seedSlot(h, 2, 'two@x');
      await h.credentials.writeActive(asSecret(oauth('one@x')));

      const target = { ...h.roster.read().accounts['2'], slot: 2 } as never;
      const result = await doSwitch(h, target, true);

      expect(result.ok).toBe(true);
      expect(result.detail).toContain('DRY RUN');
      const active = await h.credentials.readActive();
      expect(active.kind === 'found' && JSON.parse(active.value).claudeAiOauth.refreshToken).toBe(
        'rt-one@x',
      );
      expect(h.roster.read().activeSlot).toBeNull();
    } finally {
      cleanup(h.root);
    }
  });

  it('refuses a slot that is not in the roster', async () => {
    const h = harness();
    try {
      await seedSlot(h, 1, 'one@x');
      const result = await doSwitch(h, { slot: 9, email: 'ghost@x' });
      expect(result.ok).toBe(false);
      expect(result.detail).toContain('not in the roster');
    } finally {
      cleanup(h.root);
    }
  });
});
