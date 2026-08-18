/**
 * Copying transcripts into a git repository rotorcc owns, and optionally
 * mirroring them off the machine.
 *
 * Why a copy and not a link: Claude Code already writes every transcript to
 * disk, and a switch or a crash deletes none of it. What actually goes missing
 * is the ability to find yesterday's session after a cleanup, a disk failure or
 * a laptop that does not come back. So this is a backup, and git is the backup
 * format: append-only JSONL deltas compress into almost nothing, history is
 * free, and `git log` is a usable answer to "what did it look like at 3am".
 *
 * Why the copy is done by hand rather than by rsync: rsync is not on Windows,
 * and the local half of this has to work everywhere. Files are compared on size
 * and mtime, so an unchanged 77MB transcript costs one stat, not one copy.
 */
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
  copyFileSync,
  utimesSync,
} from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

import type { Config } from '../config/schema.js';
import type { Logger } from './log.js';
import { run } from './proc.js';
import { type SecretHit, compilePatterns, scanText } from './secrets.js';

export interface CopiedFile {
  /** Path relative to the store root. */
  relativePath: string;
  bytes: number;
  /** Bytes that were not in the previous copy; the region the screen reads. */
  appendedFrom: number;
  isNew: boolean;
}

export interface SnapshotResult {
  storePath: string;
  filesCopied: number;
  bytesCopied: number;
  commit: string | null;
  committed: boolean;
  secretHits: SecretHit[];
  mirror: { attempted: boolean; ok: boolean; detail: string };
  sources: string[];
  skipped: string[];
  durationMs: number;
}

function listFilesRecursive(root: string, out: string[] = [], base = root): string[] {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = join(root, name);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) listFilesRecursive(full, out, base);
    else if (stat.isFile()) out.push(relative(base, full));
  }
  return out;
}

/**
 * Read the region of a file that is new since the previous copy. For the
 * append-only transcripts this is the whole point: a 77MB session file is
 * screened over its last few kilobytes, not re-read every 45 seconds.
 */
async function readAppendedRegion(path: string, from: number, maxBytes: number): Promise<string> {
  const size = statSync(path).size;
  // Overlap by a little so a credential straddling the previous boundary is
  // still seen whole.
  const start = Math.max(0, Math.min(from, size) - 512);
  const end = Math.min(size, start + maxBytes);
  if (end <= start) return '';
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    createReadStream(path, { start, end: end - 1 })
      .on('data', (chunk) => chunks.push(chunk as Buffer))
      .on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      .on('error', reject);
  });
}

export interface SnapshotSource {
  /** Directory to copy from. */
  from: string;
  /** Path under the store root to copy into. */
  to: string;
}

export interface SnapshotOptions {
  config: Config;
  sources: SnapshotSource[];
  trigger: string;
  sessionId?: string | undefined;
  logger: Logger;
  /** Skip the git commit and the mirror; still reports what it would do. */
  dryRun?: boolean;
  /**
   * Do not attempt the off-machine mirror on this snapshot.
   *
   * Set for hook-triggered checkpoints. The mirror is a backup of a backup: its
   * failure never endangers work, but its SLOWNESS does endanger the tool. A
   * mirror target that has run out of disk once blocked a checkpoint here for
   * 135 seconds, long enough for the next hook's checkpoint to stack behind it.
   * The scheduled tick mirrors instead — it already runs alone, under a lock.
   */
  skipMirror?: boolean;
}

function shouldSkip(relativePath: string, excludes: string[]): boolean {
  const normalised = relativePath.split(sep).join('/');
  return excludes.some((fragment) => normalised.includes(fragment));
}

async function ensureStoreRepo(storePath: string, gitCommand: string[]): Promise<void> {
  mkdirSync(storePath, { recursive: true });
  if (existsSync(join(storePath, '.git'))) return;
  await run([...gitCommand, 'init', '-q'], { cwd: storePath, timeoutMs: 30_000 });
  // The store holds one machine's transcripts and nothing else; a name and
  // email are set locally so commits never depend on a global git identity.
  await run([...gitCommand, 'config', 'user.name', 'rotorcc'], { cwd: storePath });
  await run([...gitCommand, 'config', 'user.email', 'rotorcc@localhost'], { cwd: storePath });
  const readme = join(storePath, 'README.md');
  if (!existsSync(readme)) {
    writeFileSync(
      readme,
      [
        '# rotorcc transcript store',
        '',
        'Automatic copies of Claude Code session transcripts, one commit per',
        'snapshot. Managed by `rotorcc`; safe to delete, and safe to `git gc`.',
        '',
      ].join('\n'),
      'utf8',
    );
  }
}

export async function snapshot(options: SnapshotOptions): Promise<SnapshotResult> {
  const started = Date.now();
  const { config, sources, logger } = options;
  const dryRun = options.dryRun ?? config.dryRun;
  const storePath = config.storePath;
  const patterns = compilePatterns(config.secretsScreen.extraPatterns);

  await ensureStoreRepo(storePath, config.commands.git);

  const copied: CopiedFile[] = [];
  const skipped: string[] = [];
  let bytesCopied = 0;

  for (const source of sources) {
    if (!existsSync(source.from)) {
      skipped.push(`${source.from} (missing)`);
      continue;
    }
    const destRoot = join(storePath, source.to);
    for (const rel of listFilesRecursive(source.from)) {
      if (shouldSkip(rel, config.snapshot.exclude)) continue;
      const from = join(source.from, rel);
      const to = join(destRoot, rel);
      let sourceStat;
      try {
        sourceStat = statSync(from);
      } catch {
        continue;
      }
      if (config.snapshot.maxFileBytes > 0 && sourceStat.size > config.snapshot.maxFileBytes) {
        skipped.push(`${rel} (${sourceStat.size} bytes exceeds maxFileBytes)`);
        continue;
      }

      let previousSize = 0;
      let unchanged = false;
      try {
        const destStat = statSync(to);
        previousSize = destStat.size;
        unchanged =
          destStat.size === sourceStat.size &&
          Math.floor(destStat.mtimeMs / 1000) >= Math.floor(sourceStat.mtimeMs / 1000);
      } catch {
        /* not copied before */
      }
      if (unchanged) continue;

      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(from, to);
      try {
        utimesSync(to, sourceStat.atime, sourceStat.mtime);
      } catch {
        /* some filesystems refuse; the size comparison still holds */
      }
      copied.push({
        relativePath: join(source.to, rel).split(sep).join('/'),
        bytes: sourceStat.size,
        appendedFrom: previousSize,
        isNew: previousSize === 0,
      });
      bytesCopied += Math.max(0, sourceStat.size - previousSize);
    }
  }

  // Screen only the delta. Everything copied is already on this disk; the
  // screen exists to decide whether it may leave the machine.
  const secretHits: SecretHit[] = [];
  if (config.secretsScreen.enabled) {
    for (const file of copied) {
      const absolute = join(storePath, file.relativePath);
      try {
        const text = await readAppendedRegion(
          absolute,
          file.appendedFrom,
          config.secretsScreen.maxScanBytes,
        );
        secretHits.push(...scanText(text, file.relativePath, patterns));
      } catch {
        skipped.push(`${file.relativePath} (unreadable during secrets screen)`);
      }
    }
  }

  let commit: string | null = null;
  let committed = false;
  if (!dryRun && copied.length > 0) {
    const status = await run([...config.commands.git, 'status', '--porcelain'], {
      cwd: storePath,
      timeoutMs: 120_000,
    });
    if (status.stdout.trim() !== '') {
      await run([...config.commands.git, 'add', '-A'], { cwd: storePath, timeoutMs: 300_000 });
      const message = [
        `snapshot: ${options.trigger}`,
        '',
        `session: ${options.sessionId ?? 'unknown'}`,
        `at: ${new Date().toISOString()}`,
        `files: ${copied.length}`,
      ].join('\n');
      const result = await run([...config.commands.git, 'commit', '-q', '-m', message], {
        cwd: storePath,
        timeoutMs: 300_000,
        okCodes: [1],
      });
      if (result.code === 0) {
        committed = true;
        const rev = await run([...config.commands.git, 'rev-parse', 'HEAD'], { cwd: storePath });
        commit = rev.stdout.trim() || null;
      } else {
        logger.warn('store commit did not succeed', { detail: result.stderr.trim() });
      }
    }
  }

  const mirror =
    options.skipMirror === true
      ? { attempted: false, ok: true, detail: 'mirror deferred to the scheduled tick' }
      : await runMirror({ config, sources, secretHits, logger, dryRun });

  await maybeGc(config, logger, dryRun);

  return {
    storePath,
    filesCopied: copied.length,
    bytesCopied,
    commit,
    committed,
    secretHits,
    mirror,
    sources: sources.map((s) => s.from),
    skipped,
    durationMs: Date.now() - started,
  };
}

async function maybeGc(config: Config, logger: Logger, dryRun: boolean): Promise<void> {
  if (dryRun) return;
  const stampPath = join(config.storePath, '.rotorcc-last-gc');
  const days = config.snapshot.gcDays;
  let due = true;
  try {
    const last = Date.parse(readFileSync(stampPath, 'utf8').trim());
    due = Number.isNaN(last) || Date.now() - last > days * 86_400_000;
  } catch {
    /* never run */
  }
  if (!due) return;
  const result = await run([...config.commands.git, 'gc', '--auto', '--quiet'], {
    cwd: config.storePath,
    timeoutMs: 600_000,
    okCodes: [1],
  });
  if (result.error !== undefined) logger.warn('store gc failed', { detail: result.error });
  try {
    writeFileSync(stampPath, `${new Date().toISOString()}\n`, 'utf8');
  } catch {
    /* a failed stamp only means gc runs again next time */
  }
}

interface MirrorOptions {
  config: Config;
  sources: SnapshotSource[];
  secretHits: SecretHit[];
  logger: Logger;
  dryRun: boolean;
}

/**
 * The mirror is best-effort by design. A slow or unreachable target must never
 * delay a checkpoint: the local copy is already durable, and blocking a hook on
 * a network round trip is how a backup tool becomes the reason work is lost.
 */
async function runMirror(
  options: MirrorOptions,
): Promise<{ attempted: boolean; ok: boolean; detail: string }> {
  const { config, secretHits, logger, dryRun } = options;
  if (config.mirror.type === 'none') {
    return { attempted: false, ok: true, detail: 'no mirror configured' };
  }
  if (secretHits.length > 0) {
    const summary = secretHits
      .slice(0, 5)
      .map((h) => `${h.patternId} in ${h.file}`)
      .join(', ');
    logger.error(
      'MIRROR REFUSED: the new transcript bytes match a credential shape. ' +
        'The local copy was still made. Review the files below, rotate anything real, ' +
        'and mirror by hand once it is clean.',
      { hits: secretHits.length, summary },
    );
    return { attempted: false, ok: false, detail: `refused: secrets screen matched (${summary})` };
  }
  if (dryRun) return { attempted: false, ok: true, detail: 'dry run: mirror skipped' };

  if (config.mirror.type === 'rsync-ssh') {
    const target = config.mirror.target.endsWith('/')
      ? config.mirror.target
      : `${config.mirror.target}/`;
    const args = [
      ...config.commands.rsync,
      '-a',
      // The transcripts are append-only, so only the new tail crosses the wire.
      // The store's own `.git` is not: pack files are rewritten, and copying
      // them with --append-verify would corrupt the far side.
      '--append-verify',
      '--partial',
      '--exclude=.git/',
      '--exclude=.rotorcc-last-gc',
      `--timeout=${config.mirror.timeoutSeconds}`,
      `${config.storePath.replace(/[/\\]$/, '')}/`,
      target,
    ];
    const result = await run(args, { timeoutMs: (config.mirror.timeoutSeconds + 15) * 1000 });
    if (!result.ok) {
      logger.warn('mirror failed (local copy is unaffected)', {
        detail: (result.error ?? result.stderr).slice(0, 400),
      });
      return { attempted: true, ok: false, detail: (result.error ?? result.stderr).slice(0, 200) };
    }
    return { attempted: true, ok: true, detail: `rsync to ${target}` };
  }

  const branch = config.mirror.branch;
  const timeoutMs = (config.mirror.timeoutSeconds + 15) * 1000;
  await run([...config.commands.git, 'remote', 'add', 'rotorcc-mirror', config.mirror.target], {
    cwd: config.storePath,
    timeoutMs: 30_000,
    okCodes: [3, 128],
  });
  await run([...config.commands.git, 'remote', 'set-url', 'rotorcc-mirror', config.mirror.target], {
    cwd: config.storePath,
    timeoutMs: 30_000,
  });
  const push = await run(
    [...config.commands.git, 'push', 'rotorcc-mirror', `HEAD:refs/heads/${branch}`],
    { cwd: config.storePath, timeoutMs },
  );
  if (!push.ok) {
    logger.warn('mirror push failed (local copy is unaffected)', {
      detail: (push.error ?? push.stderr).slice(0, 400),
    });
    return { attempted: true, ok: false, detail: (push.error ?? push.stderr).slice(0, 200) };
  }
  return { attempted: true, ok: true, detail: `pushed to ${branch}` };
}
