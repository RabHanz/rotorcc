/**
 * Parsing the switcher's output. The fixtures are real captures, so a change in
 * its output shape breaks these tests rather than silently reporting 100%
 * headroom on an exhausted account.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { activeAccount, readingFromAutoStream, readingFromListOutput } from '../src/core/usage.js';

const fixtures = join(import.meta.dirname, 'fixtures', 'cswap');
const listOutput = JSON.parse(readFileSync(join(fixtures, 'list.json'), 'utf8')) as unknown;
const autoOutput = readFileSync(join(fixtures, 'auto-poll.ndjson'), 'utf8');

describe('readingFromListOutput', () => {
  it('converts reported utilisation into headroom', () => {
    const reading = readingFromListOutput(listOutput);
    const first = reading.accounts.find((a) => a.number === 1);
    // The fixture reports 7% of the five-hour window used.
    expect(first?.headroomPct).toBe(93);
    expect(first?.active).toBe(true);
  });

  it('binds on the window with the least headroom, not the account average', () => {
    const reading = readingFromListOutput(listOutput);
    const second = reading.accounts.find((a) => a.number === 2);
    // 5h is spent (100% used) while 7d is at 39%: the account is unusable.
    expect(second?.headroomPct).toBe(0);
    expect(second?.bindingWindow).toBe('5h');
    expect(second?.bindingResetsAt).toContain('2026-08-17T20:19');
  });

  it('counts per-model windows when they are selected', () => {
    const withModel = readingFromListOutput(listOutput, { models: ['Fable'] });
    const second = withModel.accounts.find((a) => a.number === 2);
    expect(second?.windows.map((w) => w.name)).toEqual(['5h', '7d', 'Fable']);
  });

  it('ignores per-model windows that were not asked for', () => {
    const reading = readingFromListOutput(listOutput, { models: ['SomeOtherModel'] });
    const first = reading.accounts.find((a) => a.number === 1);
    expect(first?.windows.map((w) => w.name)).toEqual(['5h', '7d']);
  });

  it('survives an account reporting no reset times', () => {
    const reading = readingFromListOutput(listOutput);
    const third = reading.accounts.find((a) => a.number === 3);
    expect(third?.headroomPct).toBe(100);
    expect(third?.bindingResetsAt).toBeUndefined();
  });

  it('treats an account with no windows at all as having no headroom', () => {
    const reading = readingFromListOutput({
      accounts: [{ number: 9, usage: {} }],
      activeAccountNumber: 9,
    });
    expect(reading.accounts[0]?.headroomPct).toBe(0);
    expect(reading.accounts[0]?.bindingWindow).toBe('unknown');
  });

  it('finds the active account by number and by flag', () => {
    expect(activeAccount(readingFromListOutput(listOutput))?.number).toBe(1);
    const noNumber = readingFromListOutput({
      accounts: [
        { number: 5, active: false, usage: { fiveHour: { pct: 10 } } },
        { number: 6, active: true, usage: { fiveHour: { pct: 20 } } },
      ],
    });
    expect(activeAccount(noNumber)?.number).toBe(6);
  });
});

describe('readingFromAutoStream', () => {
  it('picks the poll event out of the newline-delimited stream', () => {
    const reading = readingFromAutoStream(autoOutput);
    expect(reading).not.toBeNull();
    expect(reading?.activeAccountNumber).toBe(1);
    expect(reading?.accounts.find((a) => a.number === 1)?.headroomPct).toBe(93);
    expect(reading?.accounts.find((a) => a.number === 2)?.headroomPct).toBe(0);
  });

  it('returns null when there is no poll event to read', () => {
    expect(readingFromAutoStream('{"event":"no-switch"}\nnot json\n')).toBeNull();
  });

  it('agrees with the list reading on the same data', () => {
    const fromList = readingFromListOutput(listOutput);
    const fromAuto = readingFromAutoStream(autoOutput);
    for (const account of fromList.accounts) {
      const other = fromAuto?.accounts.find((a) => a.number === account.number);
      expect(other?.headroomPct).toBe(account.headroomPct);
    }
  });
});
