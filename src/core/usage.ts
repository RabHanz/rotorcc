/**
 * Reading live account usage from the switcher.
 *
 * The switcher reports UTILISATION per window (`pct: 100` means the window is
 * spent). rotorcc works in headroom, so the conversion happens here and only
 * here: an account's headroom is `100 - max(utilisation over every window that
 * binds it)`, because the first window to fill is the one that stops the work.
 *
 * Both shapes the switcher can emit are parsed:
 *   - `list --json`  : one object, per-account windows with reset times. Primary.
 *   - `auto --json`  : newline-delimited events, one of which carries headroom.
 *                      Used as a cross-check in `doctor`.
 */
import { z } from 'zod';

const windowSchema = z
  .object({
    pct: z.number(),
    resetsAt: z.string().optional(),
    countdown: z.string().optional(),
  })
  .passthrough();

const scopedWindowSchema = windowSchema.extend({ name: z.string() });

const accountSchema = z
  .object({
    number: z.number().int(),
    email: z.string().optional(),
    alias: z.string().optional(),
    active: z.boolean().optional(),
    usageStatus: z.string().optional(),
    // `.nullish()`, never `.optional()`. The switcher emits `"usage": null` for
    // an account whose quota it could not fetch — a token needing re-auth, a
    // transient API failure, an account it has not polled yet. `.optional()`
    // accepts `undefined` and REJECTS `null`, which is how a single unreadable
    // account blinded the entire reader on 2026-08-19: the operator hit their
    // session limit while rotorcc printed "accounts unreadable" and never
    // rotated, with two healthy accounts sitting right there.
    usage: z
      .object({
        fiveHour: windowSchema.nullish(),
        sevenDay: windowSchema.nullish(),
        scoped: z.array(scopedWindowSchema).nullish(),
      })
      .nullish(),
    usageFetchedAt: z.string().nullish(),
    usageAgeSeconds: z.number().nullish(),
  })
  .passthrough();

export const listOutputSchema = z
  .object({
    schemaVersion: z.number().optional(),
    activeAccountNumber: z.number().int().nullish(),
    // Deliberately `unknown`: accounts are parsed ONE AT A TIME in
    // `readingFromListOutput`, so a single malformed entry can never discard the
    // accounts that parsed cleanly. A rotation harness that fails closed on a
    // partial read is worse than no harness — it reports confidently and does
    // nothing.
    accounts: z.array(z.unknown()),
  })
  .passthrough();

export const autoPollEventSchema = z
  .object({
    event: z.literal('poll'),
    ts: z.string().optional(),
    active: z.object({ number: z.number().int(), email: z.string().optional() }).optional(),
    headroomPct: z.record(z.string(), z.number()).optional(),
    windowsPct: z.record(z.string(), z.record(z.string(), z.number())).optional(),
  })
  .passthrough();

export interface WindowReading {
  /** Window name: `5h`, `7d`, or a model name. */
  name: string;
  /** Headroom left in this window, 0-100. */
  headroomPct: number;
  /** ISO timestamp the window resets at, when the source reports one. */
  resetsAt?: string | undefined;
}

export interface AccountReading {
  number: number;
  email?: string | undefined;
  alias?: string | undefined;
  active: boolean;
  /** Headroom in the binding (lowest) window. */
  headroomPct: number;
  /** The window that binds, i.e. the one with the least headroom. */
  bindingWindow: string;
  /** Reset time of the binding window, when known. */
  bindingResetsAt?: string | undefined;
  windows: WindowReading[];
  /** True when the source could not fetch usage for this account. */
  stale: boolean;
}

export interface UsageReading {
  observedAt: string;
  activeAccountNumber: number | null;
  accounts: AccountReading[];
  source: 'list' | 'auto';
  /**
   * Account numbers the switcher emitted in a shape we could not parse. They are
   * excluded from `accounts` but reported here so `status` and `doctor` can say
   * so out loud. A harness that hides a partial read is how a rotation silently
   * stops happening.
   */
  unreadableAccounts?: number[];
}

function clampPct(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

/**
 * `models` selects which per-model windows count. An empty list counts them
 * all: a per-model weekly cap that is full stops the work just as hard as the
 * account-wide one, and silently ignoring it is how a session dies at "93%
 * remaining".
 */
export function readingFromListOutput(
  raw: unknown,
  options: { models?: string[]; observedAt?: string } = {},
): UsageReading {
  const parsed = listOutputSchema.parse(raw);
  const models = options.models ?? [];
  // Parse each account on its own. One entry the switcher emitted in a shape we
  // do not recognise must cost us THAT account, not every account — the whole
  // point of a rotation harness is that it still works when something is wrong.
  const unreadable: number[] = [];
  const accounts: AccountReading[] = parsed.accounts.flatMap((rawAccount, index) => {
    const result = accountSchema.safeParse(rawAccount);
    if (!result.success) {
      const n =
        typeof rawAccount === 'object' && rawAccount !== null && 'number' in rawAccount
          ? Number((rawAccount as { number?: unknown }).number)
          : index + 1;
      unreadable.push(Number.isFinite(n) ? n : index + 1);
      return [];
    }
    const account = result.data;
    const windows: WindowReading[] = [];
    const usage = account.usage;
    if (usage?.fiveHour) {
      windows.push({
        name: '5h',
        headroomPct: clampPct(100 - usage.fiveHour.pct),
        resetsAt: usage.fiveHour.resetsAt,
      });
    }
    if (usage?.sevenDay) {
      windows.push({
        name: '7d',
        headroomPct: clampPct(100 - usage.sevenDay.pct),
        resetsAt: usage.sevenDay.resetsAt,
      });
    }
    for (const scoped of usage?.scoped ?? []) {
      if (models.length > 0 && !models.includes(scoped.name)) continue;
      windows.push({
        name: scoped.name,
        headroomPct: clampPct(100 - scoped.pct),
        resetsAt: scoped.resetsAt,
      });
    }

    const binding = windows.reduce<WindowReading | undefined>(
      (worst, w) => (worst === undefined || w.headroomPct < worst.headroomPct ? w : worst),
      undefined,
    );

    const stale = account.usageStatus !== undefined && account.usageStatus !== 'ok';

    return {
      number: account.number,
      email: account.email,
      alias: account.alias,
      active:
        account.active ??
        (parsed.activeAccountNumber !== undefined && parsed.activeAccountNumber === account.number),
      // No windows reported at all is treated as no headroom, never as full
      // headroom. Guessing upward here would rotate onto a dead account.
      headroomPct: binding?.headroomPct ?? 0,
      bindingWindow: binding?.name ?? 'unknown',
      bindingResetsAt: binding?.resetsAt,
      windows,
      // An account the switcher could not fetch usage for is STALE, not empty.
      // It reports zero headroom (never rotate onto an unknown) but must not
      // silence the accounts that did report.
      stale: stale || account.usage === null || account.usage === undefined,
    };
  });

  return {
    observedAt: options.observedAt ?? new Date().toISOString(),
    activeAccountNumber:
      parsed.activeAccountNumber ?? accounts.find((a) => a.active)?.number ?? null,
    accounts,
    source: 'list',
    unreadableAccounts: unreadable,
  };
}

/** Parse the newline-delimited `auto --json` stream and keep the poll event. */
export function readingFromAutoStream(
  stdout: string,
  options: { observedAt?: string } = {},
): UsageReading | null {
  let poll: z.infer<typeof autoPollEventSchema> | null = null;
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const candidate = autoPollEventSchema.safeParse(value);
    if (candidate.success) poll = candidate.data;
  }
  if (poll === null) return null;

  const headroom = poll.headroomPct ?? {};
  const windowsPct = poll.windowsPct ?? {};
  const accounts: AccountReading[] = Object.entries(headroom).map(([key, value]) => {
    const number = Number.parseInt(key, 10);
    const windows: WindowReading[] = Object.entries(windowsPct[key] ?? {}).map(([name, used]) => ({
      name,
      headroomPct: clampPct(100 - used),
    }));
    const binding = windows.reduce<WindowReading | undefined>(
      (worst, w) => (worst === undefined || w.headroomPct < worst.headroomPct ? w : worst),
      undefined,
    );
    return {
      number,
      active: poll?.active?.number === number,
      headroomPct: clampPct(value),
      bindingWindow: binding?.name ?? 'unknown',
      windows,
      stale: false,
    };
  });

  return {
    observedAt: options.observedAt ?? poll.ts ?? new Date().toISOString(),
    activeAccountNumber: poll.active?.number ?? null,
    accounts,
    source: 'auto',
  };
}

export function activeAccount(reading: UsageReading): AccountReading | null {
  if (reading.activeAccountNumber !== null) {
    const byNumber = reading.accounts.find((a) => a.number === reading.activeAccountNumber);
    if (byNumber !== undefined) return byNumber;
  }
  return reading.accounts.find((a) => a.active) ?? null;
}
