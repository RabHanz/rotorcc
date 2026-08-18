/**
 * The hook payload contract, written against payloads captured from a live
 * Claude Code process rather than from documentation. The fixtures in
 * test/fixtures/hook-payloads are those captures, and the tests parse them.
 *
 * What each event actually carries (v2.1.x):
 *
 *   every event      session_id, transcript_path, cwd, hook_event_name
 *   SessionStart     + source: "startup" | "resume" | "clear" | "compact"
 *   SessionEnd       + reason
 *   UserPromptSubmit + prompt
 *   PreToolUse       + tool_name, tool_input, tool_use_id
 *   PostToolUse      + tool_response, duration_ms
 *   Stop             + stop_hook_active, last_assistant_message,
 *                      background_tasks[], session_crons[]
 *   SubagentStop     + agent_id, agent_type, agent_transcript_path,
 *                      background_tasks[], session_crons[]
 *   PreCompact       + trigger, custom_instructions
 *   PostCompact      + trigger, compact_summary
 *
 * `background_tasks` is the live task registry — id, type, status, description,
 * agent_type — and it is the only place a rotating process can learn what was
 * still running when it was told to stop. Nothing else on disk has it.
 *
 * Output contract, also verified live:
 *   hookSpecificOutput.additionalContext  reaches the MODEL.
 *   systemMessage                         is shown to the USER only.
 * rotorcc emits both: the model needs the instruction, the operator needs to
 * see that a rotation is in progress.
 */
import { z } from 'zod';

export const backgroundTaskSchema = z
  .object({
    id: z.string(),
    type: z.string().optional(),
    status: z.string().optional(),
    description: z.string().optional(),
    agent_type: z.string().optional(),
  })
  .passthrough();

export const hookPayloadSchema = z
  .object({
    session_id: z.string().optional(),
    transcript_path: z.string().optional(),
    cwd: z.string().optional(),
    prompt_id: z.string().optional(),
    permission_mode: z.string().optional(),
    hook_event_name: z.string().optional(),

    source: z.string().optional(),
    reason: z.string().optional(),
    prompt: z.string().optional(),
    trigger: z.string().optional(),
    custom_instructions: z.string().nullable().optional(),
    compact_summary: z.string().optional(),

    tool_name: z.string().optional(),
    tool_use_id: z.string().optional(),
    tool_input: z.record(z.string(), z.unknown()).optional(),
    tool_response: z.unknown().optional(),
    duration_ms: z.number().optional(),

    stop_hook_active: z.boolean().optional(),
    last_assistant_message: z.string().optional(),

    agent_id: z.string().optional(),
    agent_type: z.string().optional(),
    agent_transcript_path: z.string().optional(),

    background_tasks: z.array(backgroundTaskSchema).optional(),
    session_crons: z.array(z.unknown()).optional(),
  })
  .passthrough();

export type HookPayload = z.infer<typeof hookPayloadSchema>;
export type BackgroundTask = z.infer<typeof backgroundTaskSchema>;

export type HookEvent =
  | 'SessionStart'
  | 'SessionEnd'
  | 'UserPromptSubmit'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'Stop'
  | 'SubagentStop'
  | 'PreCompact'
  | 'PostCompact'
  | 'Notification';

export const HOOK_EVENTS: HookEvent[] = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
  'Notification',
];

export type ParseResult =
  { ok: true; payload: HookPayload; event: string } | { ok: false; detail: string };

/**
 * `fallbackEvent` is the event name rotorcc was invoked with on the command
 * line. It wins nothing over the payload's own `hook_event_name`; it is there
 * so a payload from an older build without that field still routes correctly.
 */
export function parseHookPayload(raw: string, fallbackEvent = ''): ParseResult {
  if (raw.trim() === '') return { ok: false, detail: 'stdin was empty' };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, detail: 'stdin was not valid JSON' };
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, detail: 'hook payload was not a JSON object' };
  }
  const parsed = hookPayloadSchema.safeParse(value);
  if (!parsed.success) {
    return { ok: false, detail: `hook payload did not match the expected shape` };
  }
  const event = parsed.data.hook_event_name ?? fallbackEvent;
  if (event === '') return { ok: false, detail: 'hook payload carried no event name' };
  return { ok: true, payload: parsed.data, event };
}

/** The transcript directory for this session: where the JSONL and subagents live. */
export function sessionTranscriptPaths(payload: HookPayload): {
  transcriptFile: string | null;
  sessionDir: string | null;
} {
  const file = payload.transcript_path ?? null;
  if (file === null) return { transcriptFile: null, sessionDir: null };
  const withoutExt = file.replace(/\.jsonl$/i, '');
  return { transcriptFile: file, sessionDir: withoutExt };
}

export interface HookResponse {
  /** Injected into the model's context. Verified to reach the model. */
  additionalContext?: string;
  /** Shown to the operator in the terminal. Does NOT reach the model. */
  systemMessage?: string;
}

export function renderHookResponse(event: string, response: HookResponse): string | null {
  const body: Record<string, unknown> = {};
  if (response.systemMessage !== undefined && response.systemMessage !== '') {
    body.systemMessage = response.systemMessage;
  }
  if (response.additionalContext !== undefined && response.additionalContext !== '') {
    // additionalContext is only honoured for the events that can inject
    // context. Emitting it elsewhere is harmless but pointless, so it is
    // dropped rather than sent.
    if (event === 'SessionStart' || event === 'UserPromptSubmit' || event === 'PostToolUse') {
      body.hookSpecificOutput = {
        hookEventName: event,
        additionalContext: response.additionalContext,
      };
    } else if (body.systemMessage === undefined) {
      body.systemMessage = response.additionalContext;
    }
  }
  if (Object.keys(body).length === 0) return null;
  return JSON.stringify(body);
}
