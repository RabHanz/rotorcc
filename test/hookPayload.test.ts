/**
 * These run against the captured payloads, so if the harness changes its hook
 * contract the tests fail here rather than in production at 3am.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  parseHookPayload,
  renderHookResponse,
  sessionTranscriptPaths,
} from '../src/core/hookPayload.js';

const dir = join(import.meta.dirname, 'fixtures', 'hook-payloads');
const files = readdirSync(dir).filter((f) => f.endsWith('.json'));

describe('parseHookPayload against captured payloads', () => {
  it('has a fixture for every event rotorcc installs a hook for', () => {
    const events = files.map((f) => f.replace('.json', ''));
    for (const required of [
      'SessionStart',
      'SessionEnd',
      'UserPromptSubmit',
      'SubagentStop',
      'Stop',
      'PreCompact',
    ]) {
      expect(events).toContain(required);
    }
  });

  it.each(files)('parses %s and recovers the event name', (file) => {
    const raw = readFileSync(join(dir, file), 'utf8');
    const result = parseHookPayload(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event).toBe(file.replace('.json', ''));
    expect(result.payload.session_id).toBeTypeOf('string');
    expect(result.payload.transcript_path).toBeTypeOf('string');
    expect(result.payload.cwd).toBeTypeOf('string');
  });

  it('reads the live task registry off SubagentStop', () => {
    const raw = readFileSync(join(dir, 'SubagentStop.json'), 'utf8');
    const result = parseHookPayload(raw);
    if (!result.ok) throw new Error('fixture did not parse');
    expect(result.payload.background_tasks).toHaveLength(1);
    expect(result.payload.background_tasks?.[0]).toMatchObject({
      type: 'subagent',
      status: 'running',
      agent_type: 'general-purpose',
    });
    expect(result.payload.agent_transcript_path).toContain('/subagents/');
  });

  it('reads Stop with an empty task list without inventing one', () => {
    const raw = readFileSync(join(dir, 'Stop.json'), 'utf8');
    const result = parseHookPayload(raw);
    if (!result.ok) throw new Error('fixture did not parse');
    expect(result.payload.background_tasks).toEqual([]);
    expect(result.payload.last_assistant_message).toBe('DONE');
  });

  it('keeps PreCompact’s null custom_instructions rather than choking on it', () => {
    const raw = readFileSync(join(dir, 'PreCompact.json'), 'utf8');
    const result = parseHookPayload(raw);
    if (!result.ok) throw new Error('fixture did not parse');
    expect(result.payload.trigger).toBe('manual');
    expect(result.payload.custom_instructions).toBeNull();
  });

  it('accepts unknown fields, so a newer harness release does not break the hook', () => {
    const result = parseHookPayload(
      JSON.stringify({ hook_event_name: 'Stop', session_id: 'x', something_new: { a: 1 } }),
    );
    expect(result.ok).toBe(true);
  });

  it('falls back to the event name on the command line', () => {
    const result = parseHookPayload(JSON.stringify({ session_id: 'x' }), 'Stop');
    expect(result.ok && result.event).toBe('Stop');
  });

  it('refuses input it cannot understand instead of guessing', () => {
    expect(parseHookPayload('')).toEqual({ ok: false, detail: 'stdin was empty' });
    expect(parseHookPayload('not json').ok).toBe(false);
    expect(parseHookPayload('[]').ok).toBe(false);
    expect(parseHookPayload('{}').ok).toBe(false);
  });
});

describe('sessionTranscriptPaths', () => {
  it('derives the sibling session directory from the transcript path', () => {
    const raw = readFileSync(join(dir, 'SubagentStop.json'), 'utf8');
    const result = parseHookPayload(raw);
    if (!result.ok) throw new Error('fixture did not parse');
    const paths = sessionTranscriptPaths(result.payload);
    expect(paths.transcriptFile).toMatch(/\.jsonl$/);
    expect(paths.sessionDir).not.toMatch(/\.jsonl$/);
    expect(result.payload.agent_transcript_path).toContain(paths.sessionDir ?? 'nope');
  });
});

describe('renderHookResponse', () => {
  it('injects context on the events that support it', () => {
    for (const event of ['SessionStart', 'UserPromptSubmit']) {
      const json = renderHookResponse(event, { additionalContext: 'hello' });
      expect(json).not.toBeNull();
      const parsed = JSON.parse(json ?? '{}') as Record<string, unknown>;
      expect(parsed.hookSpecificOutput).toEqual({
        hookEventName: event,
        additionalContext: 'hello',
      });
    }
  });

  it('carries a system message separately, because it reaches the operator not the model', () => {
    const json = renderHookResponse('UserPromptSubmit', {
      additionalContext: 'for the model',
      systemMessage: 'for the human',
    });
    const parsed = JSON.parse(json ?? '{}') as Record<string, unknown>;
    expect(parsed.systemMessage).toBe('for the human');
    expect(parsed.hookSpecificOutput).toMatchObject({ additionalContext: 'for the model' });
  });

  it('degrades context to a system message on events that cannot inject', () => {
    const json = renderHookResponse('Stop', { additionalContext: 'notice' });
    const parsed = JSON.parse(json ?? '{}') as Record<string, unknown>;
    expect(parsed.systemMessage).toBe('notice');
    expect(parsed.hookSpecificOutput).toBeUndefined();
  });

  it('emits nothing at all when there is nothing to say', () => {
    expect(renderHookResponse('Stop', {})).toBeNull();
    expect(renderHookResponse('Stop', { additionalContext: '' })).toBeNull();
  });
});
