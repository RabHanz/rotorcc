/**
 * `rotorcc accounts --token-status`.
 *
 * This surface exists to answer "where did that credential come from and is its
 * token any good", and it is one careless template literal away from being a
 * credential leak. So the load-bearing test here is the last one in each group:
 * **the output, in both forms, never contains any part of a token.** Everything
 * else is about being useful; that one is about being safe.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { AccountManager } from '../src/accounts/manager.js';
import { asSecret, credentialDiagnostics } from '../src/accounts/credentials.js';
import { RosterStore, emptyRoster } from '../src/accounts/roster.js';
import { tokenStatus } from '../src/commands/accounts.js';
import { cleanup, tempDir, testConfig } from './helpers.js';

const dirs: string[] = [];
afterEach(() => cleanup(...dirs.splice(0)));

const ACCESS = 'sk-ant-oat01-ACCESS-DO-NOT-PRINT';
const REFRESH = 'sk-ant-ort01-REFRESH-DO-NOT-PRINT';

function blob(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: ACCESS,
      refreshToken: REFRESH,
      expiresAt: Date.now() + 3_600_000,
      scopes: ['user:inference', 'user:profile'],
      subscriptionType: 'max',
      ...overrides,
    },
  });
}

interface World {
  manager: AccountManager;
  claudeHome: string;
  accountsDir: string;
  env: NodeJS.ProcessEnv;
}

function world(): World {
  const root = tempDir('rotorcc-token-status-');
  dirs.push(root);
  const claudeHome = join(root, 'claude');
  const accountsDir = join(root, 'accounts');
  mkdirSync(claudeHome, { recursive: true });
  mkdirSync(accountsDir, { recursive: true });
  const env: NodeJS.ProcessEnv = { HOME: root, CLAUDE_CONFIG_DIR: claudeHome };
  return {
    manager: new AccountManager({ accountsDir, env, platform: 'linux' } as never),
    claudeHome,
    accountsDir,
    env,
  };
}

async function capture(w: World, json = false): Promise<{ code: number; text: string }> {
  const lines: string[] = [];
  const code = await tokenStatus({
    config: testConfig(),
    manager: w.manager,
    dryRun: false,
    json,
    yes: false,
    out: (line) => lines.push(line),
  });
  return { code, text: lines.join('\n') };
}

async function addAccount(
  w: World,
  slot: number,
  email: string,
  credential: string,
): Promise<void> {
  await w.manager.credentials.writeStash(slot, email, asSecret(credential));
  const roster = new RosterStore(w.accountsDir);
  const table = roster.read();
  table.accounts[String(slot)] = {
    email,
    uuid: '',
    organizationUuid: '',
    organizationName: '',
    added: new Date().toISOString(),
    alias: '',
    disabled: false,
    kind: 'oauth',
  };
  roster.write(table);
}

describe('credentialDiagnostics', () => {
  it('describes a healthy OAuth login without quoting any of it', () => {
    const now = Date.now();
    const diagnostics = credentialDiagnostics(blob({ expiresAt: now + 3_600_000 }), now);
    expect(diagnostics.kind).toBe('oauth');
    expect(diagnostics.tokenState).toBe('valid');
    expect(diagnostics.refreshable).toBe(true);
    expect(diagnostics.subscriptionType).toBe('max');
    expect(diagnostics.expiresInSeconds).toBeGreaterThan(3500);
    expect(JSON.stringify(diagnostics)).not.toContain('ACCESS');
    expect(JSON.stringify(diagnostics)).not.toContain('REFRESH');
  });

  it('separates expired from expiring-soon, because only one of them is a problem', () => {
    const now = Date.now();
    expect(credentialDiagnostics(blob({ expiresAt: now - 1000 }), now).tokenState).toBe('expired');
    expect(credentialDiagnostics(blob({ expiresAt: now + 60_000 }), now).tokenState).toBe(
      'expiring-soon',
    );
    expect(credentialDiagnostics(blob({ expiresAt: now + 3_600_000 }), now).tokenState).toBe(
      'valid',
    );
  });

  it('reports a login with no refresh token as un-renewable', () => {
    const diagnostics = credentialDiagnostics(
      JSON.stringify({ claudeAiOauth: { accessToken: ACCESS, expiresAt: Date.now() + 1000 } }),
    );
    expect(diagnostics.refreshable).toBe(false);
  });

  it('says an API key has nothing to expire rather than inventing a state', () => {
    const diagnostics = credentialDiagnostics('sk-ant-api03-example');
    expect(diagnostics.kind).toBe('api-key');
    expect(diagnostics.tokenState).toBe('not-an-oauth-login');
    expect(diagnostics.expiresAt).toBeNull();
  });

  it('reports a missing expiry as missing, not as expired', () => {
    // A setup token has no expiry. Calling that "expired" would send an
    // operator to re-authenticate an account that is working.
    const diagnostics = credentialDiagnostics(
      JSON.stringify({ claudeAiOauth: { accessToken: ACCESS, refreshToken: REFRESH } }),
    );
    expect(diagnostics.tokenState).toBe('no-expiry-recorded');
    expect(diagnostics.expiresInSeconds).toBeNull();
  });
});

describe('accounts --token-status', () => {
  it('says plainly when there is no credential and no account', async () => {
    const w = world();
    const { code, text } = await capture(w);
    expect(code).toBe(0);
    expect(text).toContain('no Claude Code credential on this machine');
    expect(text).toContain('rotorcc manages no accounts yet');
  });

  it('labels which store the live credential came from, with the actual path', async () => {
    const w = world();
    writeFileSync(join(w.claudeHome, '.credentials.json'), blob());

    const { text } = await capture(w);
    expect(text).toContain("Claude Code's credentials file");
    expect(text).toContain(join(w.claudeHome, '.credentials.json'));
    expect(text).toContain('valid');
    expect(text).toContain('a refresh token is present');
  });

  it('labels a managed API key as coming from the global config', async () => {
    const w = world();
    writeFileSync(
      join(w.claudeHome, '.config.json'),
      JSON.stringify({ primaryApiKey: 'sk-ant-api03-EXAMPLE-KEY' }),
    );

    const { text } = await capture(w);
    expect(text).toContain("Claude Code's global config");
    expect(text).toContain('api-key');
    expect(text).not.toContain('EXAMPLE-KEY');
  });

  it('shows each stored credential with its source and expiry', async () => {
    const w = world();
    writeFileSync(join(w.claudeHome, '.credentials.json'), blob());
    await addAccount(w, 1, 'one@example.com', blob());
    await addAccount(w, 2, 'two@example.com', blob({ expiresAt: Date.now() - 5000 }));

    const { text } = await capture(w);
    expect(text).toContain('one@example.com');
    expect(text).toContain('two@example.com');
    expect(text).toContain('rotorcc credential file');
    expect(text).toContain('EXPIRED');
  });

  it('marks the account whose fingerprint matches the live credential as active', async () => {
    const w = world();
    const shared = blob();
    writeFileSync(join(w.claudeHome, '.credentials.json'), shared);
    await addAccount(w, 1, 'one@example.com', shared);
    await addAccount(w, 2, 'two@example.com', blob({ refreshToken: 'sk-ant-ort01-OTHER' }));

    const { text } = await capture(w, true);
    const report = JSON.parse(text) as {
      activeSlot: number | null;
      accounts: Array<{ slot: number; active: boolean }>;
    };
    expect(report.activeSlot).toBe(1);
    expect(report.accounts.find((a) => a.slot === 1)?.active).toBe(true);
    expect(report.accounts.find((a) => a.slot === 2)?.active).toBe(false);
  });

  it('reports a slot with no stored credential as absent, not as broken', async () => {
    const w = world();
    const roster = new RosterStore(w.accountsDir);
    const table = emptyRoster();
    table.accounts['4'] = {
      email: 'missing@example.com',
      uuid: '',
      organizationUuid: '',
      organizationName: '',
      added: new Date().toISOString(),
      alias: '',
      disabled: false,
      kind: 'oauth',
    };
    roster.write(table);

    const { text } = await capture(w);
    expect(text).toContain('no stored credential — re-add this account');
  });

  it('never prints a token, in either output form', async () => {
    const w = world();
    writeFileSync(join(w.claudeHome, '.credentials.json'), blob());
    await addAccount(w, 1, 'one@example.com', blob());
    await addAccount(w, 2, 'two@example.com', 'sk-ant-api03-A-REAL-LOOKING-KEY');

    for (const json of [false, true]) {
      const { text } = await capture(w, json);
      expect(text).not.toContain(ACCESS);
      expect(text).not.toContain(REFRESH);
      expect(text).not.toContain('A-REAL-LOOKING-KEY');
      expect(text).not.toContain('DO-NOT-PRINT');
      // Not even a fragment: `sk-ant` appears nowhere at all.
      expect(text).not.toContain('sk-ant');
    }
  });

  it('publishes only fingerprints in --json, and they are truncated hashes', async () => {
    const w = world();
    writeFileSync(join(w.claudeHome, '.credentials.json'), blob());
    await addAccount(w, 1, 'one@example.com', blob());

    const { text } = await capture(w, true);
    const report = JSON.parse(text) as {
      live: { fingerprint: string };
      accounts: Array<{ fingerprint: string }>;
    };
    expect(report.live.fingerprint).toMatch(/^rt:[0-9a-f]{12}$/);
    expect(report.accounts[0]?.fingerprint).toBe(report.live.fingerprint);
  });
});
