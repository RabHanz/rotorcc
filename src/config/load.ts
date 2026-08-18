/**
 * Reading, validating and writing config.json.
 *
 * A malformed config is a hard error everywhere except `rotorcc doctor` and
 * `rotorcc config validate`, which exist precisely to explain it. Falling back
 * to defaults on a parse failure would silently point the transcript store at
 * the wrong path, which is the one failure mode this tool cannot have.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { homedir } from 'node:os';

import { z } from 'zod';

import { appPaths } from '../core/paths.js';
import { type Config, configSchema } from './schema.js';

export class ConfigError extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** `~/x` and relative paths are resolved before anything touches the disk. */
export function expandPath(value: string, home: string = homedir(), base = process.cwd()): string {
  if (value === '') return value;
  let out = value;
  if (out === '~') out = home;
  else if (out.startsWith('~/') || out.startsWith('~\\')) out = resolve(home, out.slice(2));
  return isAbsolute(out) ? out : resolve(base, out);
}

function expandConfigPaths(config: Config, home: string): Config {
  const next: Config = {
    ...config,
    claudeHome: expandPath(config.claudeHome, home),
    storePath: expandPath(config.storePath, home),
    projects: config.projects.map((p) => ({ ...p, path: expandPath(p.path, home) })),
    successor: {
      ...config.successor,
      cwd: config.successor.cwd === '' ? '' : expandPath(config.successor.cwd, home),
    },
    logging: {
      ...config.logging,
      file: config.logging.file === '' ? '' : expandPath(config.logging.file, home),
    },
  };
  return next;
}

export function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const where = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `  ${where}: ${issue.message}`;
    })
    .join('\n');
}

export function parseConfig(raw: unknown, home: string = homedir()): Config {
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError(`config is not valid:\n${formatZodError(parsed.error)}`, '');
  }
  return expandConfigPaths(parsed.data, home);
}

export function configPathFor(explicit?: string, env: NodeJS.ProcessEnv = process.env): string {
  if (explicit !== undefined && explicit !== '') return expandPath(explicit);
  const fromEnv = env.ROTORCC_CONFIG;
  if (fromEnv !== undefined && fromEnv !== '') return expandPath(fromEnv);
  return appPaths(env).configFile;
}

export function loadConfig(explicit?: string, env: NodeJS.ProcessEnv = process.env): Config {
  const path = configPathFor(explicit, env);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new ConfigError(`no config at ${path}. Run \`rotorcc init\` first.`, path);
    }
    throw new ConfigError(`config at ${path} could not be read: ${String(err)}`, path);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ConfigError(`config at ${path} is not valid JSON.`, path);
  }

  try {
    return parseConfig(raw);
  } catch (err) {
    throw new ConfigError(err instanceof Error ? err.message : String(err), path);
  }
}

export function saveConfig(config: Config, path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

/** A config with every default filled in, for `init` and for tests. */
export function defaultConfig(
  projectPaths: string[],
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): Config {
  const paths = appPaths(env, home);
  return parseConfig(
    {
      version: 1,
      claudeHome: paths.claudeHome,
      storePath: paths.dataDir,
      projects: projectPaths.map((p) => ({ path: p })),
      logging: { file: paths.logFile },
    },
    home,
  );
}

/** Dotted-path get, for `rotorcc config <key>`. */
export function getConfigValue(config: Config, key: string): unknown {
  return key.split('.').reduce<unknown>((acc, part) => {
    if (acc === null || typeof acc !== 'object') return undefined;
    return (acc as Record<string, unknown>)[part];
  }, config);
}

/**
 * Dotted-path set with JSON-or-string coercion, for `rotorcc config set K V`.
 * The result is re-validated, so a typo produces a schema error rather than a
 * config that silently disables rotation.
 */
export function setConfigValue(config: Config, key: string, value: string): Config {
  const parts = key.split('.');
  const clone = structuredClone(config) as unknown as Record<string, unknown>;
  let cursor: Record<string, unknown> = clone;
  for (const part of parts.slice(0, -1)) {
    const next = cursor[part];
    if (next === null || typeof next !== 'object') {
      throw new ConfigError(`config key \`${key}\` has no container at \`${part}\`.`, '');
    }
    cursor = next as Record<string, unknown>;
  }
  const leaf = parts[parts.length - 1];
  if (leaf === undefined) throw new ConfigError('config key was empty.', '');

  let coerced: unknown = value;
  try {
    coerced = JSON.parse(value);
  } catch {
    /* a bare string stays a string */
  }
  cursor[leaf] = coerced;
  return parseConfig(clone);
}
