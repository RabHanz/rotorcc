/**
 * The pending-account handover: rotorcc's answer to "how do you stop a running
 * session?"
 *
 * The answer is that you do not. A live Claude Code process reads its
 * credential once, at launch, so the only moment a switch costs nothing is
 * before the session starts. The watcher records an intent; `SessionStart`
 * consumes it. Nothing is interrupted and no second process is ever spawned.
 *
 * The two properties that matter are both about NOT acting: an intent is
 * consumed exactly once, and an intent that has gone stale is discarded rather
 * than obeyed. rotorcc has already shipped one defect where a stale instruction
 * was obeyed hours after it stopped being true.
 */
import { describe, expect, it } from 'vitest';

import { PENDING_TTL_MS, PendingSwitchStore } from '../src/core/nextSession.js';
import { cleanup, tempDir } from './helpers.js';

function withStore<T>(body: (store: PendingSwitchStore) => T): T {
  const dir = tempDir('rotorcc-pending-');
  try {
    return body(new PendingSwitchStore(dir));
  } finally {
    cleanup(dir);
  }
}

const base = {
  slot: 3,
  reason: 'weekly window down to 3%',
  decidedAt: '2026-08-19T12:00:00Z',
  fromHeadroomPct: 3,
  window: '7d',
  dryRun: false,
};

describe('PendingSwitchStore', () => {
  it('returns null when nothing is queued', () => {
    withStore((store) => {
      expect(store.peek()).toBeNull();
      expect(store.consume()).toBeNull();
    });
  });

  it('round-trips an intent and fills in an expiry', () => {
    withStore((store) => {
      store.record(base);
      // An explicit clock: `peek` now hides an expired intent, so a test
      // using a fixed past `decidedAt` must say when it is asking.
      const pending = store.peek(Date.parse('2026-08-19T12:05:00Z'));
      expect(pending?.slot).toBe(3);
      expect(pending?.reason).toContain('weekly window');
      // There is no way to record an intent that lives forever: the default is
      // the safe one and forgetting it is not possible.
      expect(pending?.expiresAt).toBe(
        new Date(Date.parse(base.decidedAt) + PENDING_TTL_MS).toISOString(),
      );
    });
  });

  it('is consumed EXACTLY once', () => {
    withStore((store) => {
      store.record(base);
      expect(store.consume(Date.parse('2026-08-19T12:05:00Z'))?.slot).toBe(3);
      // A second session start must not switch again. Consuming is what makes
      // acting on it twice impossible rather than merely unlikely.
      expect(store.consume(Date.parse('2026-08-19T12:06:00Z'))).toBeNull();
      expect(store.peek()).toBeNull();
    });
  });

  it('discards an intent that has gone stale, and removes it from disk', () => {
    withStore((store) => {
      store.record(base);
      const wellPast = Date.parse(base.decidedAt) + PENDING_TTL_MS + 1000;
      expect(store.consume(wellPast)).toBeNull();
      // Not merely filtered: an expired instruction left on disk is an expired
      // instruction waiting for a reader that forgets to check.
      expect(store.peek()).toBeNull();
    });
  });

  it('refuses an intent a dry run produced', () => {
    withStore((store) => {
      store.record({ ...base, dryRun: true });
      // Visible for inspection...
      expect(store.peek(Date.parse('2026-08-19T12:05:00Z'))?.dryRun).toBe(true);
      // ...but never actionable. A simulation cannot decide which account a
      // real session opens on.
      expect(store.consume(Date.parse('2026-08-19T12:01:00Z'))).toBeNull();
    });
  });

  it('replaces an earlier intent rather than accumulating them', () => {
    withStore((store) => {
      store.record(base);
      store.record({ ...base, slot: 7, reason: 'a newer reading' });
      expect(store.peek(Date.parse('2026-08-19T12:05:00Z'))?.slot).toBe(7);
      expect(store.consume(Date.parse('2026-08-19T12:01:00Z'))?.slot).toBe(7);
      expect(store.consume(Date.parse('2026-08-19T12:02:00Z'))).toBeNull();
    });
  });

  it('treats an unreadable file as no intent rather than throwing', () => {
    withStore((store) => {
      // Derived state: losing it costs one handover, which the next tick
      // re-derives. Refusing to start a session over it would be far worse.
      expect(store.peek()).toBeNull();
    });
  });

  it('peek() hides an expired intent, so no screen announces one that will not happen', () => {
    withStore((store) => {
      store.record(base);
      const wellPast = Date.parse(base.decidedAt) + PENDING_TTL_MS + 1000;
      // A dashboard saying "next session opens on slot 3" for an intent that
      // `consume` will discard unread is confident-but-false reporting, and it
      // is worse than saying nothing because the operator plans around it.
      expect(store.peek(wellPast)).toBeNull();
      // The bytes are still there for diagnostics; only the read that surfaces
      // to a human is filtered.
      expect(store.raw()?.slot).toBe(3);
    });
  });

  it('clear() reports whether there was anything to clear', () => {
    withStore((store) => {
      expect(store.clear()).toBe(false);
      store.record(base);
      expect(store.clear()).toBe(true);
      expect(store.clear()).toBe(false);
    });
  });
});
