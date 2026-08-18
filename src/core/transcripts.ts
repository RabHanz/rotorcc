/**
 * Locating the transcripts on disk, and reading their tail.
 *
 * Two ways in, on purpose. A hook payload hands over `transcript_path`
 * directly, which is authoritative. The daemon has no payload, so it derives
 * the project's transcript directory from the project path using Claude Code's
 * own slug rule and takes the most recently written session in it. The derived
 * path is verified to exist before it is used; if the layout ever changes, the
 * daemon degrades to "no session found" rather than snapshotting the wrong tree.
 */
import { existsSync, readdirSync, readFileSync, statSync, createReadStream } from 'node:fs';
import { basename, join } from 'node:path';

import type { Config } from '../config/schema.js';
import { projectSlug } from './paths.js';
import { run } from './proc.js';

export interface SessionFile {
  sessionId: string;
  transcriptPath: string;
  /** Sibling directory holding `subagents/` and `tool-results/`, if present. */
  sessionDir: string | null;
  mtimeMs: number;
  bytes: number;
}

export function projectTranscriptDir(config: Config, projectPath: string): string {
  return join(config.claudeHome, 'projects', projectSlug(projectPath));
}

export function listSessions(transcriptDir: string): SessionFile[] {
  if (!existsSync(transcriptDir)) return [];
  const sessions: SessionFile[] = [];
  for (const name of readdirSync(transcriptDir)) {
    if (!name.endsWith('.jsonl')) continue;
    const full = join(transcriptDir, name);
    try {
      const stat = statSync(full);
      if (!stat.isFile()) continue;
      const sessionId = basename(name, '.jsonl');
      const dir = join(transcriptDir, sessionId);
      sessions.push({
        sessionId,
        transcriptPath: full,
        sessionDir: existsSync(dir) ? dir : null,
        mtimeMs: stat.mtimeMs,
        bytes: stat.size,
      });
    } catch {
      continue;
    }
  }
  return sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

export function newestSession(config: Config, projectPath: string): SessionFile | null {
  return listSessions(projectTranscriptDir(config, projectPath))[0] ?? null;
}

/** Every session across every configured project, newest first. */
export function allSessions(config: Config): Array<SessionFile & { projectPath: string }> {
  const out: Array<SessionFile & { projectPath: string }> = [];
  for (const project of config.projects) {
    for (const session of listSessions(projectTranscriptDir(config, project.path))) {
      out.push({ ...session, projectPath: project.path });
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** Read the last `bytes` of a file as UTF-8, tolerating a split multi-byte char. */
export async function readTail(path: string, bytes: number): Promise<string> {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return '';
  }
  const start = Math.max(0, size - bytes);
  if (size === 0) return '';
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    createReadStream(path, { start })
      .on('data', (chunk) => chunks.push(chunk as Buffer))
      .on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      .on('error', () => resolve(''));
  });
}

export interface LimitDetection {
  hit: boolean;
  signature: string | null;
}

/**
 * The harness reports exhaustion as ordinary text in the transcript, so that is
 * what gets matched. Signatures are literal strings from config rather than
 * regexes: the wording changes between releases, and an operator patching a
 * string in a config file should not have to think about escaping.
 */
export function detectLimitSignature(tail: string, signatures: string[]): LimitDetection {
  for (const signature of signatures) {
    if (signature !== '' && tail.includes(signature)) return { hit: true, signature };
  }
  return { hit: false, signature: null };
}

/**
 * JSONL transcripts hold JSON-escaped text, so an apostrophe in a signature
 * appears literally but a newline does not. Matching is done against both the
 * raw tail and a copy with the common JSON escapes undone.
 */
export function unescapeJsonish(tail: string): string {
  return tail
    .replace(/\\n/g, '\n')
    .replace(/\\"/g, '"')
    .replace(/\\u2019/g, '’');
}

export interface LivenessResult {
  /** Seconds since the transcript was last written. */
  idleSeconds: number;
  /** A matching process was found. Null when the check could not run. */
  processAlive: boolean | null;
  dead: boolean;
}

/**
 * "Dead" needs both halves: an idle transcript alone just means the operator
 * went to make tea. Only an idle transcript AND no live process means the
 * session is gone and its unpushed work needs rescuing.
 */
export async function checkLiveness(
  config: Config,
  transcriptPath: string,
  processMatcher = 'claude',
): Promise<LivenessResult> {
  let idleSeconds = Number.POSITIVE_INFINITY;
  try {
    idleSeconds = (Date.now() - statSync(transcriptPath).mtimeMs) / 1000;
  } catch {
    /* the transcript is gone; treat as maximally idle */
  }
  const processAlive = await isProcessRunning(processMatcher);
  const dead = idleSeconds > config.hardKill.deadAfterSeconds && processAlive === false;
  return { idleSeconds, processAlive, dead };
}

/** Cross-platform "is a process whose command line contains X running". */
export async function isProcessRunning(
  needle: string,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean | null> {
  if (platform === 'win32') {
    const result = await run(['tasklist', '/FO', 'CSV', '/NH'], { timeoutMs: 15_000 });
    if (!result.ok) return null;
    return result.stdout.toLowerCase().includes(needle.toLowerCase());
  }
  const result = await run(['ps', '-eo', 'args='], { timeoutMs: 15_000 });
  if (!result.ok) return null;
  return result.stdout
    .split(/\r?\n/)
    .some((line) => line.includes(needle) && !line.includes('rotorcc'));
}

/** The `background_tasks` array recorded by the last hook, if one wrote it. */
export function readLastKnownTasks(stateDir: string): unknown[] {
  try {
    const raw = readFileSync(join(stateDir, 'last-tasks.json'), 'utf8');
    const parsed = JSON.parse(raw) as { tasks?: unknown[] };
    return Array.isArray(parsed.tasks) ? parsed.tasks : [];
  } catch {
    return [];
  }
}
