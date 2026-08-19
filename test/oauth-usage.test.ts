/**
 * The network layer: token refresh and quota reading.
 *
 * Nothing here reaches the network. Every test injects a `fetch` that records
 * what it was asked for and answers with a fixture, which is the only way to
 * exercise the failure classification — and the classification is the whole
 * point, because getting it wrong quarantines a live account.
 *
 * The usage-response fixtures are the real shape, taken from an actual
 * response, including the parts that broke rotorcc in production.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  bindingWindow,
  fetchUsage,
  refreshToken,
  windowsFromUsageResponse,
} from '../src/accounts/oauth.js';
import { asSecret } from '../src/accounts/credentials.js';
import {
  UsageCache,
  errorToken,
  freshnessOf,
  MIN_POLL_INTERVAL_MS,
} from '../src/accounts/usageCache.js';
import { cleanup, tempDir } from './helpers.js';

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

const oauthCredential = asSecret(
  JSON.stringify({
    claudeAiOauth: {
      accessToken: 'at-old',
      refreshToken: 'rt-old',
      expiresAt: Date.now() - 1000,
      scopes: ['user:inference'],
    },
  }),
);

describe('refreshToken', () => {
  it('refuses a credential the caller marked degraded, without calling anything', async () => {
    const fetchImpl = vi.fn();
    const result = await refreshToken(oauthCredential, { degraded: true, fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toBe('degraded-refused');
    // A refresh token is one-time. Spending one that may already be superseded
    // yields invalid_grant, which then looks exactly like a dead account.
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rotates the credential in place and keeps the fields it does not own', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ access_token: 'at-new', expires_in: 3600, refresh_token: 'rt-new' }),
    );
    const result = await refreshToken(oauthCredential, { fetchImpl });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const parsed = JSON.parse(result.credential) as { claudeAiOauth: Record<string, unknown> };
    expect(parsed.claudeAiOauth.accessToken).toBe('at-new');
    expect(parsed.claudeAiOauth.refreshToken).toBe('rt-new');
    expect(parsed.claudeAiOauth.scopes).toEqual(['user:inference']);
  });

  it('keeps the old refresh token when the server did not send a new one', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ access_token: 'at-new', expires_in: 3600 }));
    const result = await refreshToken(oauthCredential, { fetchImpl });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const parsed = JSON.parse(result.credential) as { claudeAiOauth: Record<string, unknown> };
    expect(parsed.claudeAiOauth.refreshToken).toBe('rt-old');
  });

  it('classifies an explicit invalid_grant as permanent', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'invalid_grant' }, 400));
    const result = await refreshToken(oauthCredential, { fetchImpl });
    expect(result.ok === false && result.error).toBe('invalid_grant');
  });

  it("does NOT treat invalid_client as the account's fault", async () => {
    // Our client id was rejected. That is systemic and says nothing about this
    // account; striking the slot for it would quarantine a live login.
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'invalid_client' }, 400));
    const result = await refreshToken(oauthCredential, { fetchImpl });
    expect(result.ok === false && result.error).toBe('invalid_client');
  });

  it('treats a 400 with an unparseable body as TRANSIENT, not permanent', async () => {
    // A misclassified transient costs one retry. A misclassified permanent
    // wrongly quarantines an account that still works.
    const fetchImpl = vi.fn(async () => new Response('<html>gateway</html>', { status: 400 }));
    const result = await refreshToken(oauthCredential, { fetchImpl });
    expect(result.ok === false && result.error).toBe('transient');
  });

  it('treats a 500 as transient', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'invalid_grant' }, 500));
    const result = await refreshToken(oauthCredential, { fetchImpl });
    // Even with the marker present: a 5xx is not the server rejecting a grant.
    expect(result.ok === false && result.error).toBe('transient');
  });

  it('treats a torn credential as transient rather than as "no refresh token"', async () => {
    const result = await refreshToken(asSecret('{"claudeAiOa'), { fetchImpl: vi.fn() });
    expect(result.ok === false && result.error).toBe('transient');
  });

  it('reports no_refresh_token only for a structurally complete credential without one', async () => {
    const result = await refreshToken(
      asSecret(JSON.stringify({ claudeAiOauth: { accessToken: 'a' } })),
      {
        fetchImpl: vi.fn(),
      },
    );
    expect(result.ok === false && result.error).toBe('no_refresh_token');
  });

  it('classifies a network failure as transient', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const result = await refreshToken(oauthCredential, { fetchImpl });
    expect(result.ok === false && result.error).toBe('transient');
  });
});

describe('windowsFromUsageResponse', () => {
  const realShape = {
    five_hour: { utilization: 11, resets_at: '2026-08-19T23:50:00Z' },
    seven_day: { utilization: 3, resets_at: '2026-08-24T13:00:00Z' },
    limits: [
      {
        percent: 2,
        resets_at: '2026-08-24T13:00:00Z',
        scope: { model: { display_name: 'Fable' } },
      },
    ],
  };

  it('reads the 5h, 7d and per-model windows', () => {
    const snapshot = windowsFromUsageResponse(realShape, '2026-08-19T12:00:00Z');
    expect(snapshot?.windows.map((w) => w.name)).toEqual(['5h', '7d', 'Fable']);
    expect(snapshot?.windows[2]?.usedPct).toBe(2);
  });

  it('keeps the windows it CAN read when one is null', () => {
    // The 2026-08-19 defect class: an optional field declared `.optional()`
    // rejects null, and one null discarded every account. Here a null window
    // must cost that window and nothing else.
    const snapshot = windowsFromUsageResponse(
      { ...realShape, five_hour: null },
      '2026-08-19T12:00:00Z',
    );
    expect(snapshot?.windows.map((w) => w.name)).toEqual(['7d', 'Fable']);
  });

  it('survives a limits entry with no model name rather than discarding the array', () => {
    const snapshot = windowsFromUsageResponse(
      { ...realShape, limits: [{ percent: 5 }, ...realShape.limits] },
      '2026-08-19T12:00:00Z',
    );
    expect(snapshot?.windows.map((w) => w.name)).toEqual(['5h', '7d', 'Fable']);
  });

  it('returns null — not an empty snapshot — when there are no windows at all', () => {
    // Null forces the caller into its unknown branch. An empty snapshot would
    // sail through and read as "measured, nothing used".
    expect(windowsFromUsageResponse({}, '2026-08-19T12:00:00Z')).toBeNull();
  });

  it('accepts unknown extra fields, so a newer API does not break the reader', () => {
    const snapshot = windowsFromUsageResponse(
      { ...realShape, something_new: { nested: true } },
      '2026-08-19T12:00:00Z',
    );
    expect(snapshot?.windows.length).toBe(3);
  });
});

describe('bindingWindow', () => {
  const windows = [
    { name: '5h', usedPct: 11, resetsAt: null },
    { name: '7d', usedPct: 90, resetsAt: null },
    { name: 'Fable', usedPct: 99, resetsAt: null },
  ];

  it('counts every per-model window when no models are named', () => {
    // An empty list means "all". A per-model cap that is full stops the work
    // just as hard, and ignoring it is how a session dies at 89% remaining.
    expect(bindingWindow(windows, [])?.window.name).toBe('Fable');
  });

  it('counts only the named model when one is given', () => {
    const binding = bindingWindow(windows, ['Opus']);
    expect(binding?.window.name).toBe('7d');
  });

  it('always counts 5h and 7d whatever the model filter says', () => {
    expect(bindingWindow(windows, ['Opus'])?.headroomPct).toBe(10);
  });

  it('returns null with no windows, never a percentage', () => {
    expect(bindingWindow([], [])).toBeNull();
  });
});

describe('fetchUsage', () => {
  it('classifies 401 as an account problem, not a transport one', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 401 }));
    const result = await fetchUsage('at', { fetchImpl });
    expect(result.ok === false && result.error.kind).toBe('unauthorised');
  });

  it("carries the server's Retry-After through a 429", async () => {
    const fetchImpl = vi.fn(
      async () => new Response('', { status: 429, headers: { 'retry-after': '120' } }),
    );
    const result = await fetchUsage('at', { fetchImpl });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual({ kind: 'http', status: 429, retryAfterSeconds: 120 });
  });

  it('treats a 200 with no windows as a failed read, not as zero usage', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}));
    const result = await fetchUsage('at', { fetchImpl });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('bad-response');
  });

  it('sends the bearer token in a header and never in the URL', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ five_hour: { utilization: 10 } }));
    await fetchUsage('secret-token', { fetchImpl });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).not.toContain('secret-token');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer secret-token');
  });
});

describe('usage cache', () => {
  it('keeps the last good windows through a failure, with their age', () => {
    const dir = tempDir('rotorcc-cache-');
    try {
      const cache = new UsageCache(dir);
      const fetchedAt = new Date(Date.now() - 240_000).toISOString();
      cache.recordSuccess(1, [{ name: '5h', usedPct: 20, resetsAt: null }], fetchedAt);
      cache.recordFailure(1, { kind: 'timeout' });

      const entry = cache.entry(1);
      // 20% used four minutes ago beats "unknown"; the age is what makes it
      // honest rather than a stale number pretending to be current.
      expect(entry?.windows?.[0]?.usedPct).toBe(20);
      expect(entry?.lastError).toBe('timeout');
      expect(freshnessOf(entry).kind).toBe('fresh');
    } finally {
      cleanup(dir);
    }
  });

  it('reports never-read as its own state, distinct from stale', () => {
    expect(freshnessOf(undefined).kind).toBe('never-read');
    const old = {
      consecutiveFailures: 0,
      fetchedAt: new Date(Date.now() - 20 * 3_600_000).toISOString(),
    };
    expect(freshnessOf(old).kind).toBe('expired');
  });

  it('honours the poll floor, and lets force override it', () => {
    const dir = tempDir('rotorcc-cache-');
    try {
      const cache = new UsageCache(dir);
      cache.recordSuccess(
        1,
        [{ name: '5h', usedPct: 20, resetsAt: null }],
        new Date().toISOString(),
      );
      expect(cache.mayPoll(1)).toBe(false);
      expect(cache.mayPoll(1, { force: true })).toBe(true);
      expect(cache.mayPoll(1, { nowMs: Date.now() + MIN_POLL_INTERVAL_MS + 1000 })).toBe(true);
    } finally {
      cleanup(dir);
    }
  });

  it('does NOT let force override a server-imposed backoff', () => {
    const dir = tempDir('rotorcc-cache-');
    try {
      const cache = new UsageCache(dir);
      cache.recordFailure(1, { kind: 'http', status: 429, retryAfterSeconds: 600 });
      // Hammering an endpoint that just said 429 helps nobody, and the budget
      // running out is how rotorcc ends up knowing nothing about any account.
      expect(cache.mayPoll(1, { force: true })).toBe(false);
    } finally {
      cleanup(dir);
    }
  });

  it('backs off further with each consecutive failure', () => {
    const dir = tempDir('rotorcc-cache-');
    try {
      const cache = new UsageCache(dir);
      cache.recordFailure(1, { kind: 'timeout' });
      const first = Date.parse(cache.entry(1)?.backoffUntil ?? '');
      cache.recordFailure(1, { kind: 'timeout' });
      cache.recordFailure(1, { kind: 'timeout' });
      const third = Date.parse(cache.entry(1)?.backoffUntil ?? '');
      expect(third).toBeGreaterThan(first);
      expect(cache.entry(1)?.consecutiveFailures).toBe(3);
    } finally {
      cleanup(dir);
    }
  });

  it('gives every failure kind a short stable token safe to log', () => {
    expect(errorToken({ kind: 'http', status: 429, retryAfterSeconds: null })).toBe('http-429');
    expect(errorToken({ kind: 'unauthorised' })).toBe('unauthorised');
    expect(errorToken({ kind: 'network', detail: 'x' })).toBe('network');
  });
});
