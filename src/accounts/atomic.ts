/**
 * Atomic, permission-pinned file writes.
 *
 * Everything under `src/accounts` writes credentials or credential-adjacent
 * state, so every write in this subsystem goes through here and gets three
 * properties it must not be possible to forget:
 *
 *   1. **Atomic publication.** Write a temp file in the SAME directory, then
 *      rename. A rename within one filesystem is atomic on POSIX and on NTFS,
 *      so a reader either sees the whole old file or the whole new one. A
 *      truncate-then-write leaves a window where the file is empty — and an
 *      empty credential file reads as "this account has no login".
 *
 *   2. **0600 before anything sensitive is in it.** The mode is set on the temp
 *      file's descriptor before the bytes are written, not on the target
 *      afterwards. Chmod-after leaves the content world-readable for however
 *      long the process takes to get to the chmod, which on a shared box is a
 *      real window and not a theoretical one.
 *
 *   3. **A bounded retry on Windows.** `rename` onto a just-created file fails
 *      transiently there with EPERM/EBUSY while an antivirus scanner or the
 *      search indexer holds the target open. POSIX has no such window, so the
 *      retry is Windows-only and every other error surfaces on the first
 *      attempt rather than being slept over.
 *
 * The temp file is unlinked on every failure path. A crashed rotorcc must not
 * leave a readable credential fragment behind in the accounts directory.
 */
import {
  closeSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

/** Windows error codes that mean "someone else has this open right now". */
const TRANSIENT_WINDOWS_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

export interface AtomicWriteOptions {
  /** File mode for the published file. Ignored on Windows, which has no bits. */
  mode?: number;
  /** How many times to retry the rename past a transient Windows failure. */
  attempts?: number;
  /** Injected for tests; defaults to the real platform. */
  isWindows?: boolean;
}

function sleepBusy(ms: number): void {
  // A synchronous wait, deliberately. The whole point of this module is that a
  // credential write is one indivisible step no other code can interleave with,
  // and making it async would let a caller forget an `await` between the write
  // and the rename. Windows-only, bounded to a few hundred milliseconds total.
  const until = Date.now() + ms;
  while (Date.now() < until) {
    /* spin */
  }
}

/**
 * Write `contents` to `target` atomically, creating parent directories.
 *
 * Returns the path written, so call sites can log where something landed
 * without recomputing it (and getting it subtly wrong).
 */
export function writeFileAtomic(
  target: string,
  contents: string,
  options: AtomicWriteOptions = {},
): string {
  const mode = options.mode ?? 0o600;
  const attempts = options.attempts ?? 10;
  const isWindows = options.isWindows ?? process.platform === 'win32';
  const dir = dirname(target);

  mkdirSync(dir, { recursive: true, mode: 0o700 });

  // Same directory as the target: a rename across filesystems is a copy, and a
  // copy is not atomic. `process.pid` plus a counter keeps two rotorcc
  // processes from colliding on the temp name.
  const temp = join(dir, `.rotorcc-${process.pid}-${nextSequence()}.tmp`);

  // `wx` fails if the name somehow exists rather than silently truncating
  // whatever is there. `mode` is applied by open(2) itself, so the descriptor is
  // never world-readable, not even for an instant.
  const fd = openSync(temp, 'wx', mode);
  try {
    writeSync(fd, contents, 0, 'utf8');
  } finally {
    closeSync(fd);
  }

  let lastError: unknown;
  for (let attempt = 0; attempt < Math.max(1, attempts); attempt += 1) {
    try {
      renameSync(temp, target);
      return target;
    } catch (err) {
      lastError = err;
      const code = (err as NodeJS.ErrnoException).code ?? '';
      const transient = isWindows && TRANSIENT_WINDOWS_CODES.has(code);
      if (!transient || attempt === Math.max(1, attempts) - 1) break;
      sleepBusy(Math.min(250, 2 * 2 ** attempt));
    }
  }

  try {
    unlinkSync(temp);
  } catch {
    /* the write failed and so did the cleanup; the throw below is the report */
  }
  throw lastError;
}

/** `writeFileAtomic` for a JSON value, pretty-printed and newline-terminated. */
export function writeJsonAtomic(
  target: string,
  value: unknown,
  options: AtomicWriteOptions = {},
): string {
  return writeFileAtomic(target, `${JSON.stringify(value, null, 2)}\n`, options);
}

let sequence = 0;
function nextSequence(): number {
  sequence += 1;
  return sequence;
}

/**
 * Create a directory with 0700, including parents.
 *
 * Broken out because `mkdirSync`'s `mode` applies only to directories it
 * actually creates, and the default 0777-minus-umask on an intermediate
 * directory is how an accounts directory ends up group-readable on a box whose
 * umask is 022.
 */
export function ensurePrivateDir(path: string): string {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return path;
}

/**
 * Write a file that is expected to already exist and be private, without the
 * temp-file dance: used only for zero-byte marker files, never for content.
 */
export function touchPrivate(path: string): void {
  ensurePrivateDir(dirname(path));
  writeFileSync(path, '', { mode: 0o600 });
}
