/**
 * The macOS Keychain, through the `security` CLI.
 *
 * `security` rather than a native binding on purpose: rotorcc has one runtime
 * dependency and adding a compiled one would mean a install that fails on the
 * machine somebody is mid-crisis on. The CLI ships with the OS.
 *
 * Two rules this module exists to enforce:
 *
 *   - A secret is NEVER passed as an argv element. `security add-generic-password
 *     -w <secret>` puts the token in the process table where every user on the
 *     box can read it with `ps`. The secret goes to stdin via `-X` (hex) instead.
 *   - "Absent" and "unreadable" are different answers. `security` exits 44 for an
 *     item that does not exist and non-zero-not-44 for a locked, denied or
 *     timed-out keychain. Collapsing those into `null` is how a locked keychain
 *     gets reported as "this account has no login" and sends an operator to a
 *     re-login that cannot help.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** `security`'s exit code for "that item is not in the keychain". */
export const ERR_ITEM_NOT_FOUND = 44;

export class KeychainError extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
    this.name = 'KeychainError';
  }
}

export type KeychainResult =
  { kind: 'found'; value: string } | { kind: 'absent' } | { kind: 'unreadable'; detail: string };

export function isMacOS(plat: string = process.platform): boolean {
  return plat === 'darwin';
}

/**
 * The keychain "account" field Claude Code uses for its own items: the local
 * user name. Falls back through the usual environment variables so a launchd
 * agent with a thin environment still resolves it.
 */
export function keychainAccountName(env: NodeJS.ProcessEnv = process.env): string {
  return env.USER ?? env.LOGNAME ?? env.USERNAME ?? 'unknown';
}

function hexEncode(value: string): string {
  return Buffer.from(value, 'utf8').toString('hex');
}

function hexDecode(value: string): string {
  return Buffer.from(value.replace(/\s+/g, ''), 'hex').toString('utf8');
}

/**
 * Read a generic password.
 *
 * `-w` prints the value alone. When the stored value was written with `-X` the
 * printed form is hex, which is exactly what we want: a credential JSON blob
 * containing a newline survives the round trip unchanged, where the plain form
 * would be ambiguous.
 */
export async function getPassword(
  service: string,
  account: string,
  timeoutMs = 10_000,
): Promise<KeychainResult> {
  try {
    const { stdout } = await execFileAsync(
      'security',
      ['find-generic-password', '-s', service, '-a', account, '-w'],
      { timeout: timeoutMs, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
    );
    const raw = stdout.trim();
    if (raw === '') return { kind: 'absent' };
    // A value we wrote is hex. A value Claude Code wrote is the JSON itself.
    // Deciding by shape rather than by a flag we would have to keep in sync.
    if (/^[0-9a-fA-F]+$/.test(raw) && raw.length % 2 === 0 && !raw.startsWith('{')) {
      try {
        const decoded = hexDecode(raw);
        // Only accept the hex reading when it produces something plausible;
        // otherwise the value really was a plain hex-looking string.
        if (decoded.startsWith('{') || decoded.startsWith('sk-ant')) {
          return { kind: 'found', value: decoded };
        }
      } catch {
        /* not hex after all */
      }
    }
    return { kind: 'found', value: raw };
  } catch (err) {
    const e = err as ExecError;
    if (e.code === ERR_ITEM_NOT_FOUND) return { kind: 'absent' };
    // Never include stdout: on a partial failure `security` can echo the value.
    const detail = typeof e.code === 'string' ? e.code : `security exited ${String(e.code)}`;
    return { kind: 'unreadable', detail };
  }
}

/**
 * What `execFile` rejects with. Declared rather than intersected with
 * `NodeJS.ErrnoException`, whose `code` is typed `string` — the intersection
 * narrows to `string` and makes the numeric exit-code comparison below a type
 * error, which is how the "item not found" case gets quietly dropped.
 */
interface ExecError {
  code?: number | string;
  message?: string;
}

/**
 * Write a generic password, replacing any existing item.
 *
 * `-U` updates in place. `-X` takes the value as hex, which keeps the secret
 * out of the process table only if the hex itself is not on the command line —
 * so it goes to stdin, and `-X -` is not a thing `security` supports, which is
 * why the value is written through the child's stdin with `-w` omitted.
 *
 * `security` reads the password from stdin when neither `-w` nor `-X` carries a
 * value, so this passes the hex on stdin and marks it hex with `-X`.
 */
export async function setPassword(
  service: string,
  account: string,
  value: string,
  timeoutMs = 10_000,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = execFile(
      'security',
      ['add-generic-password', '-U', '-s', service, '-a', account, '-X'],
      { timeout: timeoutMs, encoding: 'utf8' },
      (err) => {
        if (err) {
          const e = err as ExecError;
          reject(
            new KeychainError(
              `keychain write failed for service ${service}`,
              typeof e.code === 'number' ? e.code : -1,
            ),
          );
          return;
        }
        resolve();
      },
    );
    child.stdin?.end(hexEncode(value));
  });
}

/** Delete a generic password. Absent counts as success; anything else throws. */
export async function deletePassword(
  service: string,
  account: string,
  timeoutMs = 10_000,
): Promise<void> {
  try {
    await execFileAsync('security', ['delete-generic-password', '-s', service, '-a', account], {
      timeout: timeoutMs,
      encoding: 'utf8',
    });
  } catch (err) {
    const e = err as ExecError;
    if (e.code === ERR_ITEM_NOT_FOUND) return;
    throw new KeychainError(
      `keychain delete failed for service ${service}`,
      typeof e.code === 'number' ? e.code : -1,
    );
  }
}

/** Claude Code's own OAuth credential item. */
export const CLAUDE_OAUTH_SERVICE = 'Claude Code-credentials';
/** Claude Code's managed API-key item, a separate auth axis from OAuth. */
export const CLAUDE_MANAGED_KEY_SERVICE = 'Claude Code';
/** rotorcc's own per-account stash. Distinct from any other tool's namespace. */
export const ROTORCC_SERVICE = 'rotorcc';
