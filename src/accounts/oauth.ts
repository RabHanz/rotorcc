/**
 * Talking to Anthropic: refreshing an OAuth token, and reading quota.
 *
 * These are the only two network calls rotorcc makes, both to Anthropic's own
 * endpoints, both authenticated with the operator's own credential. There is no
 * telemetry, no analytics, no update check, and no third-party host anywhere in
 * this file or reachable from it. That is a property worth being able to verify
 * by reading one module.
 *
 * Two endpoints:
 *   POST https://platform.claude.com/v1/oauth/token   refresh grant
 *   GET  https://api.anthropic.com/api/oauth/usage    quota windows
 *
 * The single most important rule here: a refresh token is ONE-TIME. POSTing it
 * returns a new one and kills the old. So a refresh that is attempted on bytes
 * that might already be superseded does not merely fail — it produces
 * `invalid_grant`, which looks exactly like a dead account, on an account that
 * was perfectly alive. Every caller therefore has to prove its bytes are the
 * current generation before it consumes them, and `refreshToken` refuses a
 * credential the caller has marked degraded.
 *
 * Endpoint URLs, the beta header, the client id and the response shapes were
 * learned from claude-swap (MIT, Onur Cetinkol) — see THIRD-PARTY-NOTICES.md.
 */
import { z } from 'zod';

import { type Secret, asSecret, oauthPayload } from './credentials.js';

export const OAUTH_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
export const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
export const OAUTH_BETA_HEADER = 'oauth-2025-04-20';
/** Claude Code's public OAuth client id. Not a secret; it is in every client. */
export const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

/** Identifies rotorcc to Anthropic's endpoints. Carries no machine identity. */
export const USER_AGENT = 'rotorcc';

export type RefreshError =
  /** The server rejected the grant: this refresh lineage is dead, re-login. */
  | 'invalid_grant'
  /** OUR client id was rejected. Systemic — says nothing about the account. */
  | 'invalid_client'
  /** The credential has no refresh token to use. Permanent for retry purposes. */
  | 'no_refresh_token'
  /** Network, timeout, 5xx, unparseable body. The token may still be fine. */
  | 'transient'
  /** The caller handed us bytes that may be superseded. Never consumed. */
  | 'degraded-refused';

export type RefreshResult =
  | { ok: true; credential: Secret; identity: TokenIdentity | null }
  | { ok: false; error: RefreshError; detail: string };

export interface TokenIdentity {
  uuid: string | null;
  email: string | null;
  organizationUuid: string | null;
  organizationName: string | null;
}

const tokenResponseSchema = z
  .object({
    access_token: z.string().min(1),
    expires_in: z.number(),
    refresh_token: z.string().optional(),
    scope: z.string().optional(),
    account: z
      .object({
        uuid: z.string().nullish(),
        email_address: z.string().nullish(),
      })
      .nullish(),
    organization: z
      .object({
        uuid: z.string().nullish(),
        name: z.string().nullish(),
      })
      .nullish(),
  })
  .passthrough();

export interface FetchLike {
  (url: string, init?: RequestInit): Promise<Response>;
}

/**
 * Exchange a refresh token for a fresh access token.
 *
 * `degraded` is not an optional nicety. Pass `true` whenever the credential
 * came from a backend that may lag the real one (see `CredentialStore
 * .readActive`), and this refuses rather than spending a token that is possibly
 * already spent.
 */
export async function refreshToken(
  credential: Secret,
  options: { degraded?: boolean; timeoutMs?: number; fetchImpl?: FetchLike } = {},
): Promise<RefreshResult> {
  if (options.degraded === true) {
    return {
      ok: false,
      error: 'degraded-refused',
      detail:
        'the credential was read from a fallback backend and may be a superseded ' +
        'generation; refusing to spend its refresh token',
    };
  }

  let parsed: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(credential);
    if (typeof value !== 'object' || value === null) {
      // A non-object is more likely a torn read than a real credential shape,
      // and `no_refresh_token` is a PERMANENT verdict. Transient costs a retry;
      // a wrong permanent verdict quarantines a live account.
      return { ok: false, error: 'transient', detail: 'credential is not a JSON object' };
    }
    parsed = value as Record<string, unknown>;
  } catch {
    return { ok: false, error: 'transient', detail: 'credential is not parseable JSON' };
  }

  const oauth = oauthPayload(credential);
  if (oauth === null || typeof oauth.refreshToken !== 'string' || oauth.refreshToken === '') {
    return { ok: false, error: 'no_refresh_token', detail: 'no refresh token in this credential' };
  }

  const doFetch = options.fetchImpl ?? (globalThis.fetch as FetchLike);
  let response: Response;
  try {
    response = await doFetch(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: oauth.refreshToken,
        client_id: OAUTH_CLIENT_ID,
      }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    });
  } catch (err) {
    return { ok: false, error: 'transient', detail: describeNetworkError(err) };
  }

  if (!response.ok) {
    // Permanent only when the server itself rejected the grant: a 4xx AND an
    // explicit RFC 6749 §5.2 `error` member in the body. A substring scan
    // misclassifies — the marker can appear inside an unrelated envelope's
    // detail text — and a wrong permanent verdict quarantines a live account.
    if ([400, 401, 403].includes(response.status)) {
      let marker: unknown;
      try {
        const body: unknown = await response.json();
        marker =
          typeof body === 'object' && body !== null
            ? (body as { error?: unknown }).error
            : undefined;
      } catch {
        marker = undefined;
      }
      if (marker === 'invalid_grant') {
        return { ok: false, error: 'invalid_grant', detail: 'the refresh token was rejected' };
      }
      if (marker === 'invalid_client') {
        return {
          ok: false,
          error: 'invalid_client',
          detail: "rotorcc's OAuth client id was rejected; this says nothing about the account",
        };
      }
    }
    return { ok: false, error: 'transient', detail: `HTTP ${response.status}` };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, error: 'transient', detail: 'token endpoint returned unparseable JSON' };
  }
  const token = tokenResponseSchema.safeParse(body);
  if (!token.success) {
    return { ok: false, error: 'transient', detail: 'token endpoint returned an unexpected shape' };
  }

  const updated = { ...oauth } as Record<string, unknown>;
  updated.accessToken = token.data.access_token;
  updated.expiresAt = Date.now() + token.data.expires_in * 1000;
  if (token.data.refresh_token !== undefined && token.data.refresh_token !== '') {
    updated.refreshToken = token.data.refresh_token;
  }
  if (token.data.scope !== undefined) updated.scopes = token.data.scope.split(' ');
  parsed.claudeAiOauth = updated;

  return {
    ok: true,
    credential: asSecret(JSON.stringify(parsed)),
    identity: identityFromTokenResponse(token.data),
  };
}

function identityFromTokenResponse(
  data: z.infer<typeof tokenResponseSchema>,
): TokenIdentity | null {
  const account = data.account ?? null;
  const organization = data.organization ?? null;
  if (account === null && organization === null) return null;
  return {
    uuid: account?.uuid ?? null,
    email: account?.email_address ?? null,
    organizationUuid: organization?.uuid ?? null,
    organizationName: organization?.name ?? null,
  };
}

// ---------------------------------------------------------------------- usage

/** One quota window, as rotorcc models it: headroom, not utilisation. */
export interface UsageWindow {
  /** `5h`, `7d`, or a model display name such as `Opus`. */
  name: string;
  /** Percent of the window consumed, 0-100, exactly as the API reported it. */
  usedPct: number;
  /** ISO time the window resets, when the API sent one. */
  resetsAt: string | null;
}

export interface UsageSnapshot {
  windows: UsageWindow[];
  /** When rotorcc observed this, as an ISO string. */
  fetchedAt: string;
}

export type UsageFetchError =
  | { kind: 'http'; status: number; retryAfterSeconds: number | null }
  | { kind: 'timeout' }
  | { kind: 'network'; detail: string }
  | { kind: 'bad-response'; detail: string }
  | { kind: 'unauthorised' };

export type UsageFetchResult =
  { ok: true; snapshot: UsageSnapshot } | { ok: false; error: UsageFetchError };

const usageWindowSchema = z
  .object({ utilization: z.number(), resets_at: z.string().nullish() })
  .passthrough();

const usageResponseSchema = z
  .object({
    five_hour: usageWindowSchema.nullish(),
    seven_day: usageWindowSchema.nullish(),
    limits: z
      .array(
        z
          .object({
            percent: z.number().nullish(),
            resets_at: z.string().nullish(),
            scope: z
              .object({
                model: z.object({ display_name: z.string().nullish() }).nullish(),
              })
              .nullish(),
          })
          .passthrough(),
      )
      .nullish(),
  })
  .passthrough();

/**
 * Normalise the usage endpoint's response into windows.
 *
 * Every field is `nullish` and every window is optional, deliberately. This is
 * the exact shape of the bug that cost a session on 2026-08-19: an optional
 * field declared with `.optional()` rejects `null`, one account came back with
 * `"usage": null`, and the strict parse discarded all three accounts. Anything
 * the response does not carry is simply a window we do not have — not a reason
 * to throw away the windows we do.
 */
export function windowsFromUsageResponse(raw: unknown, fetchedAt: string): UsageSnapshot | null {
  const parsed = usageResponseSchema.safeParse(raw);
  if (!parsed.success) return null;
  const windows: UsageWindow[] = [];

  const named: Array<[z.infer<typeof usageWindowSchema> | null | undefined, string]> = [
    [parsed.data.five_hour, '5h'],
    [parsed.data.seven_day, '7d'],
  ];
  for (const [window, label] of named) {
    if (window !== null && window !== undefined && typeof window.utilization === 'number') {
      windows.push({
        name: label,
        usedPct: window.utilization,
        resetsAt: window.resets_at ?? null,
      });
    }
  }

  // Per-model weekly caps live in the newer `limits` array. The legacy
  // five_hour/seven_day keys never expose these, so an account can be at 3% on
  // both of those and still be unable to run a single Opus request.
  for (const limit of parsed.data.limits ?? []) {
    const name = limit.scope?.model?.display_name;
    if (typeof name !== 'string' || name === '') continue;
    if (typeof limit.percent !== 'number') continue;
    windows.push({ name, usedPct: limit.percent, resetsAt: limit.resets_at ?? null });
  }

  return windows.length === 0 ? null : { windows, fetchedAt };
}

/** Fetch quota for one access token. */
export async function fetchUsage(
  accessToken: string,
  options: { timeoutMs?: number; fetchImpl?: FetchLike; now?: () => Date } = {},
): Promise<UsageFetchResult> {
  const doFetch = options.fetchImpl ?? (globalThis.fetch as FetchLike);
  const now = options.now ?? (() => new Date());
  let response: Response;
  try {
    response = await doFetch(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'anthropic-beta': OAUTH_BETA_HEADER,
        'User-Agent': USER_AGENT,
      },
      signal: AbortSignal.timeout(options.timeoutMs ?? 8_000),
    });
  } catch (err) {
    const detail = describeNetworkError(err);
    return {
      ok: false,
      error:
        detail.includes('abort') || detail.includes('timeout')
          ? { kind: 'timeout' }
          : { kind: 'network', detail },
    };
  }

  if (response.status === 401 || response.status === 403) {
    return { ok: false, error: { kind: 'unauthorised' } };
  }
  if (!response.ok) {
    const header = response.headers.get('retry-after');
    const retryAfterSeconds =
      header === null ? null : Number.isFinite(Number(header)) ? Math.max(0, Number(header)) : null;
    return { ok: false, error: { kind: 'http', status: response.status, retryAfterSeconds } };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    return { ok: false, error: { kind: 'bad-response', detail: describeNetworkError(err) } };
  }

  const snapshot = windowsFromUsageResponse(body, now().toISOString());
  if (snapshot === null) {
    // A 200 that carries no window data at all. Reported as a failed read, not
    // as "zero usage" — the whole point is that unknown is not a number.
    return {
      ok: false,
      error: { kind: 'bad-response', detail: 'the usage response carried no quota windows' },
    };
  }
  return { ok: true, snapshot };
}

/**
 * An error string that is safe to log.
 *
 * Never includes the request body or headers, because both carry the token.
 */
function describeNetworkError(err: unknown): string {
  if (err instanceof Error) {
    const name = err.name === 'TimeoutError' || err.name === 'AbortError' ? 'timeout' : err.name;
    return `${name}: ${err.message.slice(0, 120)}`;
  }
  return 'unknown network error';
}

/**
 * Headroom in the binding window: `100 - max(used)` over every window that
 * gates this account.
 *
 * `models` selects which per-model windows count. An empty list counts them
 * ALL, which is the safe default: a per-model cap that is full stops the work
 * just as hard as the account-wide one, and quietly ignoring it is how a
 * session dies at "93% remaining".
 *
 * Returns null when there are no windows. Null is the honest answer and every
 * caller must handle it; returning 0 would make an unread account look spent,
 * and returning 100 would make it look like the best target on the box.
 */
export function bindingWindow(
  windows: UsageWindow[],
  models: string[] = [],
): { window: UsageWindow; headroomPct: number } | null {
  const wanted = models.map((m) => m.toLowerCase());
  const matchAll = wanted.length === 0 || wanted.includes('all');
  const relevant = windows.filter(
    (w) => w.name === '5h' || w.name === '7d' || matchAll || wanted.includes(w.name.toLowerCase()),
  );
  if (relevant.length === 0) return null;
  const worst = relevant.reduce((a, b) => (b.usedPct > a.usedPct ? b : a));
  return { window: worst, headroomPct: clampPct(100 - worst.usedPct) };
}

export function clampPct(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}
