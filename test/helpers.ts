import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseConfig } from '../src/config/load.js';
import type { Config } from '../src/config/schema.js';
import { Logger } from '../src/core/log.js';

export const quietLogger = new Logger({ level: 'error' });

export function tempDir(prefix = 'rotorcc-test-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function cleanup(...dirs: string[]): void {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
}

export function testConfig(overrides: Partial<Config> = {}, root = tempDir()): Config {
  const base = parseConfig({
    version: 1,
    claudeHome: join(root, 'claude'),
    storePath: join(root, 'store'),
    projects: [{ path: join(root, 'project') }],
    logging: { file: join(root, 'rotorcc.log'), level: 'error' },
  });
  return { ...base, ...overrides } as Config;
}
