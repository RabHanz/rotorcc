/**
 * One unreadable account must never blind the reader.
 *
 * 2026-08-19, production: the operator hit their session limit while rotorcc's
 * watcher ticked every 60s and printed `accounts unreadable — expected object,
 * received null`. The switcher had emitted `"usage": null` for account 3; the
 * schema used `.optional()`, which accepts `undefined` and rejects `null`; and
 * the call site used `.parse()`, which throws. So a single account the switcher
 * could not describe discarded the readings for two healthy accounts, and no
 * rotation ever fired.
 *
 * A rotation harness that fails closed on a partial read is worse than none: it
 * reports confidently and does nothing.
 */
import { describe, expect, it } from 'vitest';
import { readingFromListOutput } from '../src/core/usage.js';

const observedAt = '2026-08-19T18:30:00.000Z';

describe('readingFromListOutput — partial reads', () => {
  it('reads the healthy accounts when one reports usage: null', () => {
    const reading = readingFromListOutput(
      {
        schemaVersion: 1,
        activeAccountNumber: 2,
        accounts: [
          { number: 1, email: 'a@example.com', usage: { sevenDay: { pct: 67 } } },
          { number: 2, email: 'b@example.com', usage: { sevenDay: { pct: 55 } } },
          // The exact shape that broke production.
          { number: 3, email: 'c@example.com', usage: null, usageStatus: 'error' },
        ],
      },
      { observedAt },
    );

    expect(reading.accounts).toHaveLength(3);
    expect(reading.accounts[0]?.headroomPct).toBe(33);
    expect(reading.accounts[1]?.headroomPct).toBe(45);

    // The unreadable one is present, stale, and reports NO headroom — we must
    // never rotate onto an account whose quota we could not read.
    const third = reading.accounts[2];
    expect(third?.stale).toBe(true);
    expect(third?.headroomPct).toBe(0);
  });

  it('still yields a usable reading when an account is structurally malformed', () => {
    const reading = readingFromListOutput(
      {
        accounts: [
          { number: 1, usage: { fiveHour: { pct: 10 } } },
          // No `number` at all: unparseable as an account.
          { email: 'broken@example.com', usage: 'not-an-object' },
          { number: 3, usage: { fiveHour: { pct: 90 } } },
        ],
      },
      { observedAt },
    );

    // The two good accounts survive; the malformed one is dropped and named.
    expect(reading.accounts.map((a) => a.number)).toEqual([1, 3]);
    expect(reading.unreadableAccounts).toContain(2);
  });

  it('treats a missing usage key the same as an explicit null', () => {
    const reading = readingFromListOutput(
      { accounts: [{ number: 1 }, { number: 2, usage: { sevenDay: { pct: 20 } } }] },
      { observedAt },
    );
    expect(reading.accounts[0]?.stale).toBe(true);
    expect(reading.accounts[0]?.headroomPct).toBe(0);
    expect(reading.accounts[1]?.headroomPct).toBe(80);
  });

  it('accepts null inside the window fields without discarding the account', () => {
    const reading = readingFromListOutput(
      {
        accounts: [{ number: 1, usage: { fiveHour: null, sevenDay: { pct: 40 }, scoped: null } }],
      },
      { observedAt },
    );
    expect(reading.accounts).toHaveLength(1);
    expect(reading.accounts[0]?.headroomPct).toBe(60);
    expect(reading.accounts[0]?.bindingWindow).toBe('7d');
  });
});
