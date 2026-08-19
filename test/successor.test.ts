/**
 * The successor launcher shells out to tmux, so these tests drive it with a
 * fake tmux: a Node script that answers `list-sessions` from a fixture and
 * records every invocation. What is under test is the decision — which session,
 * which argv, what it reports — not tmux itself.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseConfig } from '../src/config/load.js';
import type { Config } from '../src/config/schema.js';
import { launchSuccessor, pickTmuxSession, renderCommand } from '../src/core/successor.js';
import { cleanup, quietLogger, tempDir } from './helpers.js';

let root: string;
let callLog: string;
let sessionsFile: string;
let config: Config;

function writeFakeTmux(path: string): void {
  writeFileSync(
    path,
    `import { appendFileSync, readFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify('__LOG__')}, JSON.stringify(args) + '\\n');
if (args[0] === 'list-sessions') {
  process.stdout.write(readFileSync(${JSON.stringify('__SESSIONS__')}, 'utf8'));
} else if (args[0] === 'new-window') {
  process.stdout.write('picked:9\\n');
} else if (args[0] === 'capture-pane') {
  process.stdout.write('rotorcc resume: read the manifest\\n');
}
process.exit(0);
`
      .replace('__LOG__', callLog)
      .replace('__SESSIONS__', sessionsFile),
    'utf8',
  );
}

function calls(): string[][] {
  if (!existsSync(callLog)) return [];
  return readFileSync(callLog, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as string[]);
}

beforeEach(() => {
  root = tempDir('rotorcc-successor-');
  callLog = join(root, 'tmux-calls.log');
  sessionsFile = join(root, 'sessions.txt');
  const fakeTmux = join(root, 'fake-tmux.mjs');
  writeFakeTmux(fakeTmux);
  writeFileSync(sessionsFile, 'alpha\tdetached\nbravo\tattached\ncharlie\tdetached\n');

  config = parseConfig({
    claudeHome: join(root, 'claude'),
    storePath: join(root, 'store'),
    projects: [{ path: join(root, 'project') }],
    commands: { tmux: [process.execPath, fakeTmux] },
    successor: { launcher: 'tmux', readyTimeoutSeconds: 3, sendKeysFallback: false },
  });
});

afterEach(() => cleanup(root));

describe('pickTmuxSession', () => {
  it('prefers the predecessor’s own session over an attached one', async () => {
    expect(await pickTmuxSession(config, 'charlie:2')).toBe('charlie');
  });

  it('falls back to an attached session when the predecessor is unknown', async () => {
    expect(await pickTmuxSession(config)).toBe('bravo');
  });

  it('falls back to the first session when nothing is attached', async () => {
    writeFileSync(sessionsFile, 'alpha\tdetached\nbravo\tdetached\n');
    expect(await pickTmuxSession(config)).toBe('alpha');
  });

  it('ignores a predecessor session that no longer exists', async () => {
    expect(await pickTmuxSession(config, 'ghost:1')).toBe('bravo');
  });

  it('reports none when tmux has no sessions', async () => {
    writeFileSync(sessionsFile, '');
    expect(await pickTmuxSession(config)).toBeNull();
  });
});

describe('renderCommand', () => {
  it('substitutes the prompt without touching the rest of the argv', () => {
    expect(renderCommand(['claude', '--continue', '{{prompt}}'], 'go on then')).toEqual([
      'claude',
      '--continue',
      'go on then',
    ]);
  });

  it('leaves a template with no placeholder alone', () => {
    expect(renderCommand(['claude'], 'ignored')).toEqual(['claude']);
  });
});

describe('launchSuccessor', () => {
  it('opens a window beside the predecessor and passes the prompt as one argument', async () => {
    const result = await launchSuccessor({
      config,
      logger: quietLogger,
      cwd: join(root, 'project'),
      prompt: 'rotorcc resume: read the manifest',
      dryRun: false,
      predecessorAlive: false,
      preferTarget: 'charlie:2',
    });

    expect(result.ok).toBe(true);
    const newWindow = calls().find((c) => c[0] === 'new-window');
    expect(newWindow).toBeDefined();
    expect(newWindow).toContain('charlie');
    // The prompt is one argv element, so no quoting question ever arises.
    expect(newWindow).toContain('rotorcc resume: read the manifest');
    expect(result.promptConfirmed).toBe(true);
  });

  it('changes nothing under dry run, and says what it would have done', async () => {
    const result = await launchSuccessor({
      config,
      logger: quietLogger,
      cwd: join(root, 'project'),
      prompt: 'p',
      dryRun: true,
      predecessorAlive: false,
    });
    expect(result.ok).toBe(true);
    expect(result.detail).toContain('dry run');
    expect(calls().some((c) => c[0] === 'new-window')).toBe(false);
  });

  it('reports the workspace trust dialog instead of answering it', async () => {
    const fakeTmux = join(root, 'fake-tmux.mjs');
    writeFileSync(
      fakeTmux,
      `import { appendFileSync, readFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(callLog)}, JSON.stringify(args) + '\\n');
if (args[0] === 'list-sessions') process.stdout.write(readFileSync(${JSON.stringify(sessionsFile)}, 'utf8'));
else if (args[0] === 'new-window') process.stdout.write('bravo:3\\n');
else if (args[0] === 'capture-pane') process.stdout.write('Do you trust this folder?\\n 1. Yes\\n');
process.exit(0);
`,
      'utf8',
    );
    const result = await launchSuccessor({
      config,
      logger: quietLogger,
      cwd: join(root, 'project'),
      prompt: 'p',
      dryRun: false,
      predecessorAlive: false,
    });
    expect(result.warnings.join(' ')).toContain('trusted');
    expect(result.promptConfirmed).toBe(false);
    // It must not have typed an answer into the dialog.
    expect(calls().some((c) => c[0] === 'send-keys')).toBe(false);
  });

  it('reports when there is no conversation to continue', async () => {
    const fakeTmux = join(root, 'fake-tmux.mjs');
    writeFileSync(
      fakeTmux,
      `import { appendFileSync, readFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(callLog)}, JSON.stringify(args) + '\\n');
if (args[0] === 'list-sessions') process.stdout.write(readFileSync(${JSON.stringify(sessionsFile)}, 'utf8'));
else if (args[0] === 'new-window') process.stdout.write('bravo:3\\n');
else if (args[0] === 'capture-pane') process.stdout.write('No conversation found to continue\\n');
process.exit(0);
`,
      'utf8',
    );
    const result = await launchSuccessor({
      config,
      logger: quietLogger,
      cwd: join(root, 'project'),
      prompt: 'p',
      dryRun: false,
      predecessorAlive: false,
    });
    expect(result.warnings.join(' ')).toContain('no previous conversation');
  });

  it('does nothing but say so when no launcher is configured', async () => {
    const none = parseConfig({
      ...(JSON.parse(JSON.stringify(config)) as object),
      successor: { launcher: 'none' },
    });
    const result = await launchSuccessor({
      config: none,
      logger: quietLogger,
      cwd: root,
      prompt: 'p',
      dryRun: false,
      predecessorAlive: false,
    });
    expect(result.ok).toBe(true);
    expect(result.launcher).toBe('none');
    expect(calls()).toEqual([]);
  });
});
