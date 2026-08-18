/**
 * `rotorcc init` — write a config that reflects this machine.
 *
 * Interactive by default and answerable by pressing Enter through it, because
 * setup friction is why tools like this never get turned on. Everything it
 * detects is shown, so a wrong guess is visible rather than buried.
 */
import { createInterface } from 'node:readline/promises';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { type Config } from '../config/schema.js';
import { configPathFor, defaultConfig, expandPath, saveConfig } from '../config/load.js';
import { appPaths, currentPlatform, isWsl } from '../core/paths.js';
import { commandExists } from '../core/proc.js';

export interface InitOptions {
  configPath?: string | undefined;
  yes: boolean;
  projectPaths: string[];
  cwd: string;
  stdout: (line: string) => void;
}

export interface Detection {
  claudeHome: string | null;
  cswap: boolean;
  git: boolean;
  tmux: boolean;
  rsync: boolean;
  gh: boolean;
  projectCandidates: string[];
  platform: string;
  wsl: boolean;
}

/** Directories under `<claudeHome>/projects` are slugs; turn them back into paths. */
export function projectsFromClaudeHome(claudeHome: string, limit = 12): string[] {
  const dir = join(claudeHome, 'projects');
  if (!existsSync(dir)) return [];
  const entries: Array<{ path: string; mtimeMs: number }> = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    try {
      const stat = statSync(full);
      if (!stat.isDirectory()) continue;
      // A slug cannot be reversed unambiguously (both `/` and `.` became `-`),
      // so candidates are offered rather than asserted, and only if they exist.
      const guess = `/${name.replace(/^-/, '').split('-').join('/')}`;
      entries.push({ path: guess, mtimeMs: stat.mtimeMs });
    } catch {
      continue;
    }
  }
  return entries
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .map((e) => e.path)
    .filter((p) => existsSync(join(p, '.git')))
    .slice(0, limit);
}

export async function detect(cwd: string): Promise<Detection> {
  const paths = appPaths();
  const claudeHome = existsSync(paths.claudeHome) ? paths.claudeHome : null;
  const [cswap, git, tmux, rsync, gh] = await Promise.all([
    commandExists(['cswap']),
    commandExists(['git']),
    commandExists(['tmux']),
    commandExists(['rsync']),
    commandExists(['gh']),
  ]);
  const candidates = new Set<string>();
  if (existsSync(join(cwd, '.git'))) candidates.add(cwd);
  if (claudeHome !== null) for (const p of projectsFromClaudeHome(claudeHome)) candidates.add(p);
  return {
    claudeHome,
    cswap,
    git,
    tmux,
    rsync,
    gh,
    projectCandidates: [...candidates],
    platform: currentPlatform(),
    wsl: isWsl(),
  };
}

export async function runInit(options: InitOptions): Promise<{ config: Config; path: string }> {
  const { stdout } = options;
  const detection = await detect(options.cwd);
  const paths = appPaths();
  const configPath = configPathFor(options.configPath);

  stdout('rotorcc init');
  stdout('');
  stdout(`  platform          ${detection.platform}${detection.wsl ? ' (WSL)' : ''}`);
  stdout(`  claude home       ${detection.claudeHome ?? 'not found'}`);
  stdout(`  account switcher  ${detection.cswap ? 'cswap found' : 'cswap NOT found'}`);
  stdout(`  git               ${detection.git ? 'found' : 'NOT found'}`);
  stdout(`  tmux              ${detection.tmux ? 'found' : 'not found'}`);
  stdout(`  rsync             ${detection.rsync ? 'found' : 'not found'}`);
  stdout('');

  let projects = options.projectPaths.map((p) => expandPath(p, undefined, options.cwd));
  if (projects.length === 0) projects = detection.projectCandidates.slice(0, 1);

  let storePath = paths.dataDir;
  let claudeHome = detection.claudeHome ?? paths.claudeHome;
  let launcher: 'tmux' | 'none' = detection.tmux ? 'tmux' : 'none';
  let mirrorTarget = '';

  if (!options.yes) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const ask = async (question: string, fallback: string): Promise<string> => {
        const answer = (await rl.question(`${question} [${fallback}] `)).trim();
        return answer === '' ? fallback : answer;
      };

      claudeHome = await ask('Claude Code home', claudeHome);
      const projectAnswer = await ask(
        'Project path(s) to watch, comma separated',
        projects.join(',') || options.cwd,
      );
      projects = projectAnswer
        .split(',')
        .map((p) => expandPath(p.trim(), undefined, options.cwd))
        .filter((p) => p !== '');
      storePath = await ask('Transcript store (a git repo rotorcc will own)', storePath);
      mirrorTarget = await ask(
        'Off-machine mirror, as an rsync target (blank for none)',
        mirrorTarget,
      );
      if (detection.tmux) {
        const answer = await ask('Launch the replacement session in tmux? (yes/no)', 'yes');
        launcher = answer.toLowerCase().startsWith('y') ? 'tmux' : 'none';
      }
    } finally {
      rl.close();
    }
  }

  if (projects.length === 0) projects = [resolve(options.cwd)];

  const config = defaultConfig(projects);
  config.claudeHome = claudeHome;
  config.storePath = storePath;
  config.successor.launcher = launcher;
  if (mirrorTarget !== '') {
    config.mirror = { type: 'rsync-ssh', target: mirrorTarget, timeoutSeconds: 120 };
  }

  saveConfig(config, configPath);
  stdout('');
  stdout(`Wrote ${configPath}`);
  stdout('');
  stdout('Next:');
  stdout(`  rotorcc install-hooks ${projects[0] ?? ''}   # continuous checkpointing`);
  stdout('  rotorcc install-scheduler                    # the every-minute watcher');
  stdout('  rotorcc doctor                               # check it all landed');
  return { config, path: configPath };
}
