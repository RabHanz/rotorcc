/**
 * Reading and writing Claude Code's ACTIVE login, and rotorcc's per-account
 * stash of the logins it manages.
 *
 * This is the most dangerous file in rotorcc. Everything else can be wrong and
 * cost an operator a confusing message; this can cost them their login. The
 * rules, in the order they matter:
 *
 *   1. **A token is never printed, logged, put in an error message, or passed
 *      as a command-line argument.** Every type in here that can hold one is
 *      opaque at the boundary, and the only thing that ever leaves this module
 *      in a human-readable form is a fingerprint or a classification.
 *
 *   2. **"Absent" and "unreadable" are different answers, always.** A locked
 *      keychain that reads as "no credentials" sends an operator to a re-login
 *      that will not help, and — much worse — lets a caller conclude a slot is
 *      empty and overwrite it. `ActiveCredential.kind` keeps them apart and
 *      there is no path that collapses them.
 *
 *   3. **A degraded read is never consumed.** If the keychain failed and the
 *      plaintext file answered instead, those bytes may be a superseded
 *      generation: on macOS Claude Code writes rotations keychain-first, so the
 *      file lags. Refreshing a superseded refresh token spends a token that is
 *      already dead and produces `invalid_grant`, which then looks like a dead
 *      account. `degraded` travels with the value so refresh paths refuse it.
 *
 *   4. **Every write is atomic and 0600 from the moment it exists.** See
 *      `atomic.ts`.
 *
 * Backend routing: macOS uses the Keychain when it answers and drops to files
 * when it does not; every other platform uses files. Stash reads are
 * "file wins": a file written while the keychain was unusable is by definition
 * newer than whatever the keychain still holds, and letting a recovered
 * keychain shadow it would serve a stale credential.
 *
 * The credential-file locations, the two-lock protocol, the `.credentials.json`
 * vs keychain routing and the OAuth/API-key mutual exclusion were all learned
 * from claude-swap (MIT, Onur Cetinkol). See THIRD-PARTY-NOTICES.md.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import { claudeCredentialsPath, claudeGlobalConfigPath } from '../core/paths.js';
import { ensurePrivateDir, writeFileAtomic, writeJsonAtomic } from './atomic.js';
import {
  CLAUDE_MANAGED_KEY_SERVICE,
  CLAUDE_OAUTH_SERVICE,
  ROTORCC_SERVICE,
  deletePassword,
  getPassword,
  isMacOS,
  keychainAccountName,
  setPassword,
} from './keychain.js';

/**
 * A credential, kept as an opaque string that must never be rendered.
 *
 * A branded type rather than a bare `string`, so that a `console.log` of one is
 * a type error at the call site instead of a leak found in a support log.
 */
export type Secret = string & { readonly __secret: unique symbol };

export function asSecret(value: string): Secret {
  return value as Secret;
}

export type ActiveCredential =
  /** A credential was found. `degraded` means it may be a stale generation. */
  | { kind: 'found'; value: Secret; degraded: boolean; backend: 'keychain' | 'file' | 'config' }
  /** Every backend answered, and none of them holds a credential. */
  | { kind: 'absent' }
  /** At least one backend could not be asked. Absence proves nothing here. */
  | { kind: 'unreadable'; detail: string };

/** What kind of thing a credential blob is, decided by shape and not by hope. */
export type CredentialKind = 'oauth' | 'api-key' | 'unknown';

/**
 * A managed API key is a bare `sk-ant-api…` string; every OAuth or setup-token
 * credential is a JSON object. Strict on both halves: requiring the prefix AND
 * that it is not JSON keeps a raw `sk-ant-oat…` setup token from being filed as
 * an API key, which would route it down a path that clears the OAuth axis.
 */
export function looksLikeApiKey(value: string | null | undefined): boolean {
  if (value === null || value === undefined || value === '') return false;
  const text = value.trim();
  return text.startsWith('sk-ant-api') && !text.startsWith('{');
}

export function classifyCredential(value: string): CredentialKind {
  if (looksLikeApiKey(value)) return 'api-key';
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed === 'object' && parsed !== null && 'claudeAiOauth' in parsed) return 'oauth';
  } catch {
    /* not JSON */
  }
  return 'unknown';
}

interface OAuthPayload {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  scopes?: string[];
  subscriptionType?: string;
}

/** The `claudeAiOauth` object inside a credential blob, or null. */
export function oauthPayload(value: string): OAuthPayload | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const oauth = (parsed as Record<string, unknown>).claudeAiOauth;
    if (typeof oauth !== 'object' || oauth === null) return null;
    return oauth as OAuthPayload;
  } catch {
    return null;
  }
}

/**
 * A stable identity for a credential, safe to log.
 *
 * Hash of the refresh token when there is one, because that survives access
 * token rotation: two generations of the same login compare equal, which is the
 * question every caller is actually asking. Full-content hash otherwise, since
 * API keys and setup tokens do not rotate.
 *
 * Truncated to 12 hex characters. A full SHA-256 of a refresh token is not a
 * secret, but it is a stable global identifier for one, and there is no reason
 * to write more of it into a log than is needed to tell two apart.
 */
export function credentialFingerprint(value: string): string | null {
  if (value === '') return null;
  const oauth = oauthPayload(value);
  const token = oauth?.refreshToken;
  if (typeof token === 'string' && token !== '') {
    return `rt:${createHash('sha256').update(token).digest('hex').slice(0, 12)}`;
  }
  return `full:${createHash('sha256').update(value).digest('hex').slice(0, 12)}`;
}

/** True when an OAuth access token is expired or within five minutes of it. */
export function accessTokenExpired(expiresAt: unknown, nowMs = Date.now()): boolean {
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return false;
  return nowMs + 5 * 60 * 1000 >= expiresAt;
}

/**
 * Sibling keys of `claudeAiOauth` that belong to the MACHINE rather than to the
 * account: MCP OAuth state and plugin secrets rotate independently of any
 * account and are shared by every login on the box. On activation the live
 * copies win, so a switch does not roll a machine-wide integration back to
 * whatever it was when this slot was last active.
 *
 * Everything else — known or unknown — stays with the slot. That fails safe:
 * a stale restore of an unlisted shared field costs a re-authorisation prompt,
 * whereas carrying an account-bound field across a switch presents one
 * account's credential under another's identity.
 */
const MACHINE_SHARED_KEYS = new Set([
  'mcpOAuth',
  'mcpOAuthClientConfig',
  'mcpXaaIdp',
  'mcpXaaIdpConfig',
  'pluginSecrets',
]);

/** The machine-shared fields of a credential blob, or null if it is not one. */
export function machineSharedFields(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of MACHINE_SHARED_KEYS) {
      if (key in record) out[key] = record[key];
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * Compose the credential to activate: the target slot's login, with the
 * machine's CURRENT shared fields spliced in.
 *
 * Presence and absence are both authoritative on the live side — a shared key
 * the machine no longer holds is not resurrected from the slot's old snapshot.
 * A blob that is not an OAuth credential object passes through untouched, so
 * API keys and any future shape stay activatable verbatim.
 */
export function composeForActivation(target: Secret, live: string | null): Secret {
  if (live === null) return target;
  const shared = machineSharedFields(live);
  if (shared === null) return target;
  try {
    const parsed: unknown = JSON.parse(target);
    if (typeof parsed !== 'object' || parsed === null) return target;
    const record = parsed as Record<string, unknown>;
    if (!('claudeAiOauth' in record)) return target;
    const composed: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
      if (!MACHINE_SHARED_KEYS.has(key)) composed[key] = value;
    }
    Object.assign(composed, shared);
    return asSecret(JSON.stringify(composed));
  } catch {
    return target;
  }
}

export interface CredentialStoreOptions {
  /** rotorcc's accounts directory; the stash lives in `credentials/` under it. */
  accountsDir: string;
  env?: NodeJS.ProcessEnv;
  /** Injected for tests. */
  platform?: string;
}

/**
 * Owns where credentials live and how they are read and written.
 *
 * Deliberately has no opinion about accounts, slots or rotation — it is handed
 * a slot number and an email and does storage. Keeping orchestration out of
 * here is what makes the dangerous half small enough to read in one sitting.
 */
export class CredentialStore {
  private readonly env: NodeJS.ProcessEnv;
  private readonly platform: string;
  private readonly credentialsDir: string;
  /**
   * Sticky, process-local. Once a keychain operation fails we stay on files for
   * the rest of the process rather than alternating between backends inside one
   * command, which is how two halves of one switch land in different places.
   */
  private keychainUsable: boolean | null = null;

  constructor(options: CredentialStoreOptions) {
    this.env = options.env ?? process.env;
    this.platform = options.platform ?? process.platform;
    this.credentialsDir = join(options.accountsDir, 'credentials');
  }

  private useKeychain(): boolean {
    if (!isMacOS(this.platform)) return false;
    return this.keychainUsable !== false;
  }

  private stashPath(slot: number, email: string): string {
    // The email is part of the name so a slot that is re-pointed at a different
    // account cannot silently read the previous occupant's credential.
    return join(this.credentialsDir, `${slot}-${safeFileFragment(email)}.cred`);
  }

  private stashPreviousPath(slot: number, email: string): string {
    return `${this.stashPath(slot, email)}.prev`;
  }

  private stashKeychainAccount(slot: number, email: string): string {
    return `slot-${slot}-${email}`;
  }

  // ---------------------------------------------------------------- active

  /**
   * Read Claude Code's active credential.
   *
   * Order matters and mirrors Claude Code's own: OAuth keychain (macOS, when
   * usable), then the plaintext OAuth file that Claude Code also falls back to,
   * then the managed API key. Trying OAuth all the way down first means a macOS
   * login whose keychain item is missing but whose file is present is never
   * misread as an API-key account.
   */
  async readActive(): Promise<ActiveCredential> {
    let keychainFailed = false;

    if (this.useKeychain()) {
      const result = await getPassword(CLAUDE_OAUTH_SERVICE, keychainAccountName(this.env));
      if (result.kind === 'found') {
        return {
          kind: 'found',
          value: asSecret(result.value),
          degraded: false,
          backend: 'keychain',
        };
      }
      if (result.kind === 'unreadable') {
        this.keychainUsable = false;
        keychainFailed = true;
      }
    }

    const file = claudeCredentialsPath(this.env);
    if (existsSync(file)) {
      let text: string;
      try {
        text = readFileSync(file, 'utf8');
      } catch (err) {
        // The keychain was denied AND the fallback file is unreadable: the most
        // unreadable state there is. Reporting "absent" here would send the
        // operator to a re-login that cannot help.
        return {
          kind: 'unreadable',
          detail: `credentials file unreadable: ${(err as Error).message.slice(0, 120)}`,
        };
      }
      if (text.trim() !== '') {
        return { kind: 'found', value: asSecret(text), degraded: keychainFailed, backend: 'file' };
      }
    }

    const managed = await this.readManagedKey();
    if (managed !== null) {
      return { kind: 'found', value: managed, degraded: keychainFailed, backend: 'config' };
    }

    if (keychainFailed) {
      return { kind: 'unreadable', detail: 'macOS keychain could not be read' };
    }
    return { kind: 'absent' };
  }

  /** The active managed API key, or null. Mirrors Claude Code's resolution. */
  private async readManagedKey(): Promise<Secret | null> {
    if (this.useKeychain()) {
      const result = await getPassword(CLAUDE_MANAGED_KEY_SERVICE, keychainAccountName(this.env));
      if (result.kind === 'found') return asSecret(result.value);
      if (result.kind === 'unreadable') this.keychainUsable = false;
    }
    const config = this.readGlobalConfig();
    const key = config?.primaryApiKey;
    return typeof key === 'string' && key !== '' ? asSecret(key) : null;
  }

  readGlobalConfig(): Record<string, unknown> | null {
    const path = claudeGlobalConfigPath(this.env);
    if (!existsSync(path)) return null;
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
      return typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      // Unreadable, NOT absent. Callers must not treat this as an empty config
      // and write over it; `updateGlobalConfig` refuses in exactly that case.
      return null;
    }
  }

  /**
   * Apply `mutate` to Claude Code's global config, atomically.
   *
   * Refuses when the file exists but could not be parsed. `?? {}` there would
   * write an empty object over a torn config and take `oauthAccount`, every
   * project entry and every MCP server with it — the file holding the whole of
   * a user's Claude Code state. An ABSENT config has nothing to lose and is a
   * legitimate first write.
   */
  updateGlobalConfig(mutate: (config: Record<string, unknown>) => void): void {
    const path = claudeGlobalConfigPath(this.env);
    const existing = this.readGlobalConfig();
    if (existing === null && existsSync(path)) {
      throw new Error(
        `${path} exists but could not be parsed — refusing to overwrite it. ` +
          'Move or repair the file, then retry.',
      );
    }
    const config = existing ?? {};
    mutate(config);
    writeJsonAtomic(path, config);
  }

  /**
   * Write Claude Code's active credential, enforcing one auth axis.
   *
   * Claude Code resolves OAuth and managed API keys on separate axes and reads
   * the keychain before the file. Activating one axis therefore has to clear the
   * other, or a stale credential shadows the switch and the operator is on an
   * account they did not choose while rotorcc reports success.
   */
  async writeActive(credential: Secret): Promise<'keychain' | 'file'> {
    if (looksLikeApiKey(credential)) {
      await this.writeManagedKey(credential);
      return this.useKeychain() ? 'keychain' : 'file';
    }
    const backend = await this.writeOAuth(credential);
    await this.clearManagedKey();
    return backend;
  }

  private async writeOAuth(credential: Secret): Promise<'keychain' | 'file'> {
    if (this.useKeychain()) {
      try {
        await setPassword(CLAUDE_OAUTH_SERVICE, keychainAccountName(this.env), credential);
        return 'keychain';
      } catch {
        // Fall through to the file. Sticky from here: a write that fell back
        // must not later re-probe onto a keychain whose stale item we could not
        // verify we cleared, because Claude Code reads the keychain first.
        this.keychainUsable = false;
      }
    }
    writeFileAtomic(claudeCredentialsPath(this.env), credential, { mode: 0o600 });
    if (isMacOS(this.platform)) {
      // Claude Code reads keychain-before-file, so a residual item would
      // resurrect the old account over the file we just wrote. Best effort:
      // a keychain that is down cannot be cleaned now, and that is the
      // documented residual rather than a silent one.
      try {
        await deletePassword(CLAUDE_OAUTH_SERVICE, keychainAccountName(this.env));
      } catch {
        /* recorded by the caller as a degraded switch */
      }
    }
    return 'file';
  }

  private async writeManagedKey(key: Secret): Promise<void> {
    // Claude Code records the last 20 characters in `customApiKeyResponses
    // .approved` on every platform; without it the CLI re-prompts the user to
    // approve a key they already approved.
    const approved = key.trim().slice(-20);
    this.updateGlobalConfig((config) => {
      const responses =
        typeof config.customApiKeyResponses === 'object' && config.customApiKeyResponses !== null
          ? (config.customApiKeyResponses as Record<string, unknown>)
          : {};
      const list = Array.isArray(responses.approved) ? (responses.approved as string[]) : [];
      if (!list.includes(approved)) list.push(approved);
      responses.approved = list;
      config.customApiKeyResponses = responses;
      if (!this.useKeychain()) config.primaryApiKey = key;
    });
    if (this.useKeychain()) {
      try {
        await setPassword(CLAUDE_MANAGED_KEY_SERVICE, keychainAccountName(this.env), key);
      } catch {
        this.keychainUsable = false;
        this.updateGlobalConfig((config) => {
          config.primaryApiKey = key;
        });
      }
    }
    await this.clearOAuth();
  }

  private async clearManagedKey(): Promise<void> {
    if (isMacOS(this.platform)) {
      try {
        await deletePassword(CLAUDE_MANAGED_KEY_SERVICE, keychainAccountName(this.env));
      } catch {
        /* best effort */
      }
    }
    const path = claudeGlobalConfigPath(this.env);
    if (!existsSync(path)) return;
    const config = this.readGlobalConfig();
    if (config === null || !('primaryApiKey' in config)) return;
    // `approved` is deliberately left intact, matching Claude Code's own
    // `removeApiKey`: forgetting the approval makes the next activation of the
    // same key prompt again for no reason.
    this.updateGlobalConfig((c) => {
      delete c.primaryApiKey;
    });
  }

  private async clearOAuth(): Promise<void> {
    if (isMacOS(this.platform)) {
      try {
        await deletePassword(CLAUDE_OAUTH_SERVICE, keychainAccountName(this.env));
      } catch {
        /* best effort */
      }
    }
    const file = claudeCredentialsPath(this.env);
    try {
      if (existsSync(file)) unlinkSync(file);
    } catch {
      /* best effort */
    }
  }

  // ----------------------------------------------------------------- stash

  /**
   * Read a slot's stashed credential.
   *
   * File-wins on macOS: a file written while the keychain was unusable is by
   * construction newer than whatever the keychain still holds, and a recovered
   * keychain shadowing it would serve a superseded generation.
   */
  async readStash(slot: number, email: string): Promise<ActiveCredential> {
    const path = this.stashPath(slot, email);
    if (existsSync(path)) {
      try {
        const encoded = readFileSync(path, 'utf8');
        return {
          kind: 'found',
          value: asSecret(Buffer.from(encoded, 'base64').toString('utf8')),
          degraded: false,
          backend: 'file',
        };
      } catch (err) {
        return {
          kind: 'unreadable',
          detail: `stash for slot ${slot} unreadable: ${(err as Error).message.slice(0, 120)}`,
        };
      }
    }
    if (this.useKeychain()) {
      const result = await getPassword(ROTORCC_SERVICE, this.stashKeychainAccount(slot, email));
      if (result.kind === 'found') {
        return {
          kind: 'found',
          value: asSecret(result.value),
          degraded: false,
          backend: 'keychain',
        };
      }
      if (result.kind === 'unreadable') {
        this.keychainUsable = false;
        return { kind: 'unreadable', detail: `keychain: ${result.detail}` };
      }
    }
    return { kind: 'absent' };
  }

  /**
   * Stash a slot's credential, retaining the one it replaces as `.prev`.
   *
   * The retention is the recovery cushion for the case rotorcc cannot rule out:
   * a credential that turns out to have been mid-rotation when we captured it.
   * One generation, not a history — the older one is worthless and every extra
   * copy of a refresh token on disk is another thing to protect.
   */
  async writeStash(slot: number, email: string, credential: Secret): Promise<void> {
    ensurePrivateDir(this.credentialsDir);
    const path = this.stashPath(slot, email);

    // The cushion is taken from whatever the CURRENT stash actually is, through
    // the same file-then-keychain read the rest of the code uses.
    //
    // Reading only the plaintext file was a real gap on macOS: a successful
    // keychain write deletes that file, so from the second write onward
    // `existsSync` was false and no previous generation was ever retained — on
    // the platform where the credential moves between two backends and the
    // cushion is most likely to be needed.
    const existing = await this.readStash(slot, email);
    if (existing.kind === 'found') {
      try {
        writeFileAtomic(
          this.stashPreviousPath(slot, email),
          Buffer.from(existing.value, 'utf8').toString('base64'),
          { mode: 0o600 },
        );
      } catch {
        /* no cushion this time; the write below still has to happen */
      }
    }

    // base64 is ENCODING, not encryption, and the file mode is what protects
    // it. Encoding at all is worth it for one narrow reason: it stops a
    // credential from being matched by a careless `grep -r sk-ant` across a
    // home directory and pasted into a bug report.
    const encoded = Buffer.from(credential, 'utf8').toString('base64');
    writeFileAtomic(path, encoded, { mode: 0o600 });

    if (this.useKeychain()) {
      try {
        await setPassword(ROTORCC_SERVICE, this.stashKeychainAccount(slot, email), credential);
        // The keychain now holds the current bytes, so the file must go or a
        // file-wins read would serve the same bytes twice over — harmless — or,
        // after the next keychain write, an older generation — not harmless.
        try {
          unlinkSync(path);
        } catch {
          /* leaving the file is safe: it holds the same bytes we just wrote */
        }
      } catch {
        this.keychainUsable = false;
      }
    }
  }

  /** The retained previous generation for a slot, when there is one. */
  readPreviousStash(slot: number, email: string): Secret | null {
    const path = this.stashPreviousPath(slot, email);
    if (!existsSync(path)) return null;
    try {
      return asSecret(Buffer.from(readFileSync(path, 'utf8'), 'base64').toString('utf8'));
    } catch {
      return null;
    }
  }

  async deleteStash(slot: number, email: string): Promise<void> {
    for (const path of [this.stashPath(slot, email), this.stashPreviousPath(slot, email)]) {
      try {
        if (existsSync(path)) unlinkSync(path);
      } catch {
        /* best effort */
      }
    }
    if (isMacOS(this.platform)) {
      try {
        await deletePassword(ROTORCC_SERVICE, this.stashKeychainAccount(slot, email));
      } catch {
        /* best effort */
      }
    }
  }

  // -------------------------------------------------------- account config

  private accountConfigPath(slot: number, email: string): string {
    return join(this.credentialsDir, `${slot}-${safeFileFragment(email)}.config.json`);
  }

  /**
   * Stash the `oauthAccount` identity block from Claude Code's global config.
   *
   * Only that block, never the whole file: the rest is projects, MCP servers
   * and history that belong to the machine, and carrying a 120 MB config across
   * a switch is both slow and a way to lose whichever copy was newer.
   */
  writeAccountIdentity(slot: number, email: string, identity: unknown): void {
    ensurePrivateDir(this.credentialsDir);
    writeJsonAtomic(this.accountConfigPath(slot, email), { oauthAccount: identity });
  }

  readAccountIdentity(slot: number, email: string): unknown | null {
    const path = this.accountConfigPath(slot, email);
    if (!existsSync(path)) return null;
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
      if (typeof parsed !== 'object' || parsed === null) return null;
      return (parsed as Record<string, unknown>).oauthAccount ?? null;
    } catch {
      return null;
    }
  }

  deleteAccountIdentity(slot: number, email: string): void {
    try {
      const path = this.accountConfigPath(slot, email);
      if (existsSync(path)) unlinkSync(path);
    } catch {
      /* best effort */
    }
  }
}

/**
 * Make an email safe as a filename fragment on every platform we run on.
 *
 * Windows forbids `<>:"/\|?*`, and a `..` fragment would escape the directory.
 * Anything outside the allowlist becomes an underscore.
 */
export function safeFileFragment(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9._@-]/g, '_');
  return cleaned === '' || cleaned === '.' || cleaned === '..' ? '_' : cleaned;
}
