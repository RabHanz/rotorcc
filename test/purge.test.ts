/**
 * `rotorcc purge`.
 *
 * The two properties worth pinning are both about restraint:
 *
 *   1. **It enumerates before it deletes, and without `--yes` it only
 *      enumerates.** A destructive command that runs on the first invocation is
 *      a destructive command somebody runs by accident.
 *   2. **It never touches Claude Code's own state.** rotorcc reads and writes
 *      those files; deleting them would log an operator out of a tool they did
 *      not uninstall. The test creates them and asserts they survive.
 *
 * Every path in these tests is inside a temp directory, and each one asserts
 * that before it passes `--yes`, so a bug in path resolution fails the test
 * rather than the developer's home directory.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { AccountManager } from '../src/accounts/manager.js';
import { humanBytes, protectedPaths, purgeTargets, runPurge } from '../src/commands/purge.js';
import { Store } from '../src/core/state.js';
import type { Config } from '../src/config/schema.js';
import { cleanup, tempDir, testConfig } from './helpers.js';

const dirs: string[] = [];
afterEach(() => cleanup(...dirs.splice(0)));

interface World {
  config: Config;
  manager: AccountManager;
  store: Store;
  configPath: string;
  env: NodeJS.ProcessEnv;
  root: string;
}

function world(): World {
  const root = tempDir('rotorcc-purge-');
  dirs.push(root);

  const claudeHome = join(root, 'claude');
  const accountsDir = join(root, 'accounts');
  const stateDir = join(root, 'state');
  const storePath = join(root, 'store');
  const configPath = join(root, 'config.json');

  for (const dir of [claudeHome, accountsDir, stateDir, storePath]) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(join(accountsDir, 'roster.json'), JSON.stringify({ version: 1, accounts: {} }));
  writeFileSync(join(stateDir, 'state.json'), '{}');
  writeFileSync(join(storePath, 'transcript.jsonl'), 'x'.repeat(2048));
  writeFileSync(configPath, '{"version":1}');

  // Claude Code's own files, in the same temp home.
  writeFileSync(join(claudeHome, '.credentials.json'), '{"claudeAiOauth":{}}');
  writeFileSync(join(root, '.claude.json'), '{"oauthAccount":{}}');

  const env: NodeJS.ProcessEnv = {
    HOME: root,
    XDG_CONFIG_HOME: join(root, 'xdg-config'),
    XDG_STATE_HOME: join(root, 'xdg-state'),
    XDG_DATA_HOME: join(root, 'xdg-data'),
    CLAUDE_CONFIG_DIR: claudeHome,
  };

  const config = testConfig({
    claudeHome,
    storePath,
    accountsDir,
    logging: { file: join(stateDir, 'rotorcc.log'), level: 'error', maxBytes: 1024 },
  } as Partial<Config>);
  return {
    root,
    config,
    manager: new AccountManager({ accountsDir, env }),
    store: new Store(stateDir),
    configPath,
    env,
  };
}

function everythingUnder(root: string, paths: string[]): boolean {
  return paths.every((path) => path.startsWith(root));
}

describe('purgeTargets', () => {
  it('lists every place rotorcc keeps something, present or not', () => {
    const w = world();
    const targets = purgeTargets(w.config, w.manager, w.store, w.configPath, w.env);
    const paths = targets.map((t) => t.path);

    expect(paths).toContain(w.config.accountsDir);
    expect(paths).toContain(w.store.dir);
    expect(paths).toContain(w.config.storePath);
    expect(paths).toContain(w.configPath);
    expect(everythingUnder(w.root, paths)).toBe(true);
  });

  it('marks the credential store and the transcript store as irreversible', () => {
    const w = world();
    const targets = purgeTargets(w.config, w.manager, w.store, w.configPath, w.env);
    const accounts = targets.find((t) => t.path === w.config.accountsDir);
    const store = targets.find((t) => t.path === w.config.storePath);
    expect(accounts?.irreversible).toContain('claude /login');
    expect(store?.irreversible).toContain('transcript snapshot');
  });

  it('honours --config rather than always naming the default config file', () => {
    const w = world();
    const elsewhere = join(w.root, 'other-config.json');
    const targets = purgeTargets(w.config, w.manager, w.store, elsewhere, w.env);
    expect(targets.map((t) => t.path)).toContain(elsewhere);
    expect(targets.map((t) => t.path)).not.toContain(w.configPath);
  });
});

describe('protectedPaths', () => {
  it("names Claude Code's credential, config and home", () => {
    const w = world();
    const paths = protectedPaths(w.config, w.env).map((p) => p.path);
    expect(paths).toContain(join(w.config.claudeHome, '.credentials.json'));
    expect(paths).toContain(w.config.claudeHome);
  });
});

describe('runPurge', () => {
  it('deletes nothing without --yes, and says what it would delete', () => {
    const w = world();
    const lines: string[] = [];
    const code = runPurge({
      ...w,
      yes: false,
      dryRun: false,
      json: false,
      out: (line) => lines.push(line),
    });

    expect(code).toBe(1);
    expect(existsSync(w.config.accountsDir)).toBe(true);
    expect(existsSync(w.store.dir)).toBe(true);
    expect(existsSync(w.config.storePath)).toBe(true);

    const output = lines.join('\n');
    expect(output).toContain(w.config.accountsDir);
    expect(output).toContain(w.config.storePath);
    expect(output).toContain('Nothing was deleted');
    // It offers the way out before the destruction, not after.
    expect(output).toContain('rotorcc accounts export');
  });

  it('deletes nothing on a dry run even with --yes', () => {
    const w = world();
    const lines: string[] = [];
    const code = runPurge({
      ...w,
      yes: true,
      dryRun: true,
      json: false,
      out: (line) => lines.push(line),
    });

    expect(code).toBe(1);
    expect(lines.join('\n')).toContain('DRY RUN');
    expect(existsSync(w.config.accountsDir)).toBe(true);
  });

  it('with --yes removes rotorcc state and leaves Claude Code alone', () => {
    const w = world();
    const claudeCredential = join(w.config.claudeHome, '.credentials.json');
    const claudeConfig = join(w.root, '.claude.json');

    // Guard: everything about to be deleted is inside this test's temp root.
    const targets = purgeTargets(w.config, w.manager, w.store, w.configPath, w.env);
    expect(
      everythingUnder(
        w.root,
        targets.map((t) => t.path),
      ),
    ).toBe(true);

    const lines: string[] = [];
    const code = runPurge({
      ...w,
      yes: true,
      dryRun: false,
      json: false,
      out: (line) => lines.push(line),
    });

    expect(code).toBe(0);
    expect(existsSync(w.config.accountsDir)).toBe(false);
    expect(existsSync(w.store.dir)).toBe(false);
    expect(existsSync(w.config.storePath)).toBe(false);
    expect(existsSync(w.configPath)).toBe(false);

    expect(existsSync(claudeCredential)).toBe(true);
    expect(existsSync(claudeConfig)).toBe(true);
    expect(existsSync(w.config.claudeHome)).toBe(true);
  });

  it('names the hooks and the scheduler as things it will not remove for you', () => {
    const w = world();
    const lines: string[] = [];
    runPurge({ ...w, yes: false, dryRun: false, json: false, out: (line) => lines.push(line) });
    const output = lines.join('\n');
    expect(output).toContain('uninstall-hooks');
    expect(output).toContain('uninstall-scheduler');
  });

  it('--json without --yes reports the plan and exits non-zero', () => {
    const w = world();
    const lines: string[] = [];
    const code = runPurge({
      ...w,
      yes: false,
      dryRun: false,
      json: true,
      out: (line) => lines.push(line),
    });

    expect(code).toBe(1);
    const report = JSON.parse(lines.join('\n')) as {
      deleted: boolean;
      confirmed: boolean;
      wouldDelete: Array<{ path: string }>;
      notTouched: Array<{ path: string }>;
    };
    expect(report.deleted).toBe(false);
    expect(report.confirmed).toBe(false);
    expect(report.wouldDelete.length).toBeGreaterThan(0);
    expect(report.notTouched.length).toBeGreaterThan(0);
    expect(existsSync(w.config.accountsDir)).toBe(true);
  });
});

describe('humanBytes', () => {
  it('reads as a size a human would say', () => {
    expect(humanBytes(0)).toBe('0 B');
    expect(humanBytes(2048)).toBe('2.0 KB');
    expect(humanBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });
});
