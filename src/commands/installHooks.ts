/**
 * `rotorcc install-hooks` / `uninstall-hooks`.
 *
 * Writes into a settings file that is not ours. So: read, parse, merge, back
 * up once, write. If the file cannot be parsed we stop and say so rather than
 * replacing it with a version we understand — a settings file with a trailing
 * comma is a typo to fix, not a licence to overwrite somebody's hooks.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { appPaths } from '../core/paths.js';
import {
  type SettingsFile,
  DEFAULT_HOOK_SPECS,
  installRotorccHooks,
  installedEvents,
  removeRotorccHooks,
} from '../core/settingsMerge.js';

export interface InstallHooksOptions {
  /** Project directory whose `.claude/settings.json` is edited. */
  projectPath?: string | undefined;
  /** Edit the user-level settings file instead of a project one. */
  user?: boolean;
  /** Path to the rotorcc executable the hooks will call. */
  binary: string;
  configPath?: string | undefined;
  dryRun: boolean;
  stdout: (line: string) => void;
}

export function settingsPathFor(options: {
  projectPath?: string | undefined;
  user?: boolean;
}): string {
  if (options.user === true) return join(appPaths().claudeHome, 'settings.json');
  const project = options.projectPath;
  if (project === undefined || project === '') {
    throw new Error('install-hooks needs a project path, or --user for the user settings file');
  }
  return join(project, '.claude', 'settings.json');
}

export function readSettings(path: string): SettingsFile {
  if (!existsSync(path)) return {};
  const text = readFileSync(path, 'utf8');
  if (text.trim() === '') return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('settings file is not a JSON object');
    }
    return parsed as SettingsFile;
  } catch (err) {
    throw new Error(
      `${path} is not valid JSON (${String(err)}). Fix it by hand; rotorcc will not overwrite it.`,
    );
  }
}

function writeSettings(path: string, settings: SettingsFile, dryRun: boolean): void {
  if (dryRun) return;
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) {
    const backup = `${path}.rotorcc-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    copyFileSync(path, backup);
  }
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
}

export function install(options: InstallHooksOptions): { path: string; added: number } {
  const path = settingsPathFor(options);
  const settings = readSettings(path);
  const extraArgs = options.configPath !== undefined ? ['--config', options.configPath] : [];
  const result = installRotorccHooks(settings, options.binary, DEFAULT_HOOK_SPECS, extraArgs);
  writeSettings(path, result.settings, options.dryRun);

  options.stdout(`${options.dryRun ? 'would update' : 'updated'} ${path}`);
  options.stdout(`  events: ${installedEvents(result.settings).join(', ')}`);
  if (result.removed > 0) {
    options.stdout(`  replaced ${result.removed} existing rotorcc entr(ies)`);
  }
  options.stdout(`  hook command: ${options.binary} hook <Event>`);
  return { path, added: result.added };
}

export function uninstall(options: InstallHooksOptions): { path: string; removed: number } {
  const path = settingsPathFor(options);
  if (!existsSync(path)) {
    options.stdout(`${path} does not exist; nothing to remove`);
    return { path, removed: 0 };
  }
  const settings = readSettings(path);
  const result = removeRotorccHooks(settings);
  writeSettings(path, result.settings, options.dryRun);
  options.stdout(
    `${options.dryRun ? 'would remove' : 'removed'} ${result.removed} rotorcc hook entr(ies) from ${path}`,
  );
  return { path, removed: result.removed };
}
