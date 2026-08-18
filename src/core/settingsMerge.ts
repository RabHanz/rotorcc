/**
 * Adding and removing rotorcc's hook entries in a Claude Code settings file.
 *
 * The settings file belongs to the user. It very likely already contains hooks
 * they care about more than they care about this tool. So:
 *
 *   - entries are appended, never substituted for what is there;
 *   - rotorcc's own entries carry a sentinel argument, so removal is exact and
 *     never matches a hook that merely happens to run a similar command;
 *   - running install twice produces a byte-identical file;
 *   - install writes a timestamped backup before its first modification.
 *
 * The shape follows the settings file's own convention: `command` is the
 * program and `args` is an array, so no part of the path is ever re-parsed by
 * a shell.
 */

export const SENTINEL = '--rotorcc-managed';

export interface HookCommand {
  type: 'command';
  command: string;
  args?: string[];
  timeout?: number;
  statusMessage?: string;
  [key: string]: unknown;
}

export interface HookMatcherEntry {
  matcher?: string;
  hooks: HookCommand[];
  [key: string]: unknown;
}

export type SettingsHooks = Record<string, HookMatcherEntry[]>;

export interface SettingsFile {
  hooks?: SettingsHooks;
  [key: string]: unknown;
}

export interface HookSpec {
  event: string;
  matcher?: string;
  timeout: number;
  statusMessage?: string;
}

/**
 * Which events rotorcc installs, and why each one is there.
 *
 *  SessionStart      reconstruct after a crash; surface the resume plan.
 *  UserPromptSubmit  surface a raised soft-checkpoint or rotate flag.
 *  SubagentStop      an agent just finished: its work is the most likely thing
 *                    to be lost, and this is the cheapest moment to save it.
 *  Stop              the main loop went idle: the safe point of every turn.
 *  PreCompact        compaction is the other way context dies.
 *  SessionEnd        last chance; also records that the exit was clean.
 */
export const DEFAULT_HOOK_SPECS: HookSpec[] = [
  { event: 'SessionStart', timeout: 20, statusMessage: 'rotorcc: checking for unfinished work…' },
  { event: 'UserPromptSubmit', timeout: 10 },
  { event: 'SubagentStop', timeout: 20, statusMessage: 'rotorcc: checkpointing…' },
  { event: 'Stop', timeout: 20, statusMessage: 'rotorcc: checkpointing…' },
  { event: 'PreCompact', timeout: 20, statusMessage: 'rotorcc: snapshotting before compaction…' },
  { event: 'SessionEnd', timeout: 25 },
];

export function isRotorccHook(hook: HookCommand): boolean {
  return Array.isArray(hook.args) && hook.args.includes(SENTINEL);
}

export function buildHookCommand(
  spec: HookSpec,
  binary: string,
  extraArgs: string[] = [],
): HookCommand {
  const command: HookCommand = {
    type: 'command',
    command: binary,
    args: ['hook', spec.event, SENTINEL, ...extraArgs],
    timeout: spec.timeout,
  };
  if (spec.statusMessage !== undefined) command.statusMessage = spec.statusMessage;
  return command;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Remove every rotorcc entry, leaving everything else exactly as it was. */
export function removeRotorccHooks(settings: SettingsFile): {
  settings: SettingsFile;
  removed: number;
} {
  const next = clone(settings);
  const hooks = next.hooks;
  if (hooks === undefined) return { settings: next, removed: 0 };

  let removed = 0;
  for (const [event, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) continue;
    const kept: HookMatcherEntry[] = [];
    for (const entry of entries) {
      const inner = Array.isArray(entry.hooks) ? entry.hooks : [];
      const keptInner = inner.filter((hook) => {
        const mine = isRotorccHook(hook);
        if (mine) removed += 1;
        return !mine;
      });
      // An entry that existed only to hold our hook goes; one that held other
      // hooks too keeps them, with its matcher intact.
      if (keptInner.length > 0) kept.push({ ...entry, hooks: keptInner });
      else if (inner.length === 0) kept.push(entry);
    }
    if (kept.length > 0) hooks[event] = kept;
    else delete hooks[event];
  }
  if (Object.keys(hooks).length === 0) delete next.hooks;
  return { settings: next, removed };
}

/**
 * Install (or reinstall) rotorcc's hooks. Removing first is what makes this
 * idempotent: a second install replaces our own entries with identical ones
 * rather than stacking a duplicate on every run.
 */
export function installRotorccHooks(
  settings: SettingsFile,
  binary: string,
  specs: HookSpec[] = DEFAULT_HOOK_SPECS,
  extraArgs: string[] = [],
): { settings: SettingsFile; added: number; removed: number } {
  const cleaned = removeRotorccHooks(settings);
  const next = cleaned.settings;
  const hooks: SettingsHooks = next.hooks ?? {};
  let added = 0;

  for (const spec of specs) {
    const entry: HookMatcherEntry = { hooks: [buildHookCommand(spec, binary, extraArgs)] };
    if (spec.matcher !== undefined) entry.matcher = spec.matcher;
    const existing = Array.isArray(hooks[spec.event]) ? hooks[spec.event] : [];
    hooks[spec.event] = [...(existing ?? []), entry];
    added += 1;
  }

  next.hooks = hooks;
  return { settings: next, added, removed: cleaned.removed };
}

export function countRotorccHooks(settings: SettingsFile): number {
  let count = 0;
  for (const entries of Object.values(settings.hooks ?? {})) {
    for (const entry of entries) {
      for (const hook of entry.hooks ?? []) {
        if (isRotorccHook(hook)) count += 1;
      }
    }
  }
  return count;
}

export function installedEvents(settings: SettingsFile): string[] {
  const events: string[] = [];
  for (const [event, entries] of Object.entries(settings.hooks ?? {})) {
    if (entries.some((entry) => (entry.hooks ?? []).some(isRotorccHook))) events.push(event);
  }
  return events.sort();
}
