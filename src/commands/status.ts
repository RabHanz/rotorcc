/**
 * `rotorcc status` — one screen that answers "am I about to lose anything?"
 *
 * Ordered by what a worried operator checks first: how much account is left,
 * whether the last backup actually happened, and how much work is sitting on
 * this disk and nowhere else.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';

import type { Config } from '../config/schema.js';
import { levelFor } from '../core/decide.js';
import { run } from '../core/proc.js';
import {
  FLAG_ALL_EXHAUSTED,
  FLAG_ROTATE_NOW,
  FLAG_SOFT_CHECKPOINT,
  type Store,
} from '../core/state.js';
import { PendingSwitchStore } from '../core/nextSession.js';
import { allSessions } from '../core/transcripts.js';
import { type UsageReading, activeAccount } from '../core/usage.js';
import { discoverTrees } from '../core/worktrees.js';

export interface StatusReport {
  usage: UsageReading | null;
  usageError: string | null;
  level: string;
  store: { path: string; exists: boolean; lastCommit: string | null; lastCommitAt: string | null };
  lastSnapshotAt: string | null;
  lastManifest: string | null;
  flags: { soft: boolean; rotate: boolean; allExhausted: boolean };
  /** The account the next session will open on, when one is queued. */
  pendingHandover: { slot: number; reason: string; expiresAt: string } | null;
  lanes: Array<{
    project: string;
    tree: string;
    branch: string;
    ahead: number | null;
    dirty: number;
    protectedBranch: boolean;
  }>;
  unsavedTrees: number;
  scheduler: { detail: string };
  sessions: Array<{ project: string; sessionId: string; idleSeconds: number; bytes: number }>;
}

function ago(iso: string | null): string {
  if (iso === null) return 'never';
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  const seconds = Math.round(ms / 1000);
  if (seconds < 90) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

async function schedulerStatus(config: Config): Promise<string> {
  if (process.platform === 'linux') {
    const result = await run(
      ['systemctl', '--user', 'list-timers', '--no-pager', '--no-legend', 'rotorcc.timer'],
      { timeoutMs: 15_000, okCodes: [1, 3, 4] },
    );
    const line = result.stdout.trim();
    return line === '' ? 'systemd user timer not installed' : line.replace(/\s+/g, ' ');
  }
  if (process.platform === 'darwin') {
    const result = await run(['launchctl', 'list'], { timeoutMs: 15_000, okCodes: [1] });
    return result.stdout.includes('dev.rotorcc.watch')
      ? 'launchd agent loaded'
      : 'launchd agent not loaded';
  }
  if (process.platform === 'win32') {
    const result = await run(['schtasks', '/Query', '/TN', 'rotorcc-watch'], {
      timeoutMs: 15_000,
      okCodes: [1],
    });
    return result.ok ? 'scheduled task present' : 'scheduled task not found';
  }
  void config;
  return 'no scheduler adapter for this platform';
}

export async function buildStatus(
  config: Config,
  store: Store,
  readUsage: (config: Config) => Promise<UsageReading | { error: string }>,
): Promise<StatusReport> {
  const usageResult = await readUsage(config);
  const usage = 'error' in usageResult ? null : usageResult;
  const usageError = 'error' in usageResult ? usageResult.error : null;
  const active = usage === null ? null : activeAccount(usage);
  const level = active === null ? 'unknown' : levelFor(active.headroomPct, config.thresholds);

  const state = store.readState();

  let lastCommit: string | null = null;
  let lastCommitAt: string | null = null;
  const storeExists = existsSync(config.storePath);
  if (storeExists) {
    const log = await run([...config.commands.git, 'log', '-1', '--format=%h %s|%cI'], {
      cwd: config.storePath,
      timeoutMs: 20_000,
      okCodes: [128],
    });
    const [subject = '', when = ''] = log.stdout.trim().split('|');
    lastCommit = subject === '' ? null : subject;
    lastCommitAt = when === '' ? null : when;
  }

  const lanes: StatusReport['lanes'] = [];
  for (const project of config.projects) {
    const trees = await discoverTrees({ git: config.commands.git }, project);
    for (const tree of trees) {
      if ((tree.ahead ?? 0) > 0 || tree.dirtyFiles > 0) {
        lanes.push({
          project: project.path,
          tree: tree.path,
          branch: tree.branch,
          ahead: tree.ahead,
          dirty: tree.dirtyFiles,
          protectedBranch: tree.protectedBranch,
        });
      }
    }
  }

  const sessions = allSessions(config)
    .slice(0, 5)
    .map((s) => ({
      project: s.projectPath,
      sessionId: s.sessionId,
      idleSeconds: Math.round((Date.now() - s.mtimeMs) / 1000),
      bytes: s.bytes,
    }));

  return {
    usage,
    usageError,
    level,
    store: { path: config.storePath, exists: storeExists, lastCommit, lastCommitAt },
    lastSnapshotAt: state.lastSnapshotAt,
    lastManifest: store.latestManifest(),
    flags: {
      // The level is passed so a flag describing a world that no longer exists
      // is dropped rather than displayed. `status` showing ROTATE_NOW beside
      // "72% headroom, level ok" is the screen that told an orchestrator to
      // exit on a false alarm.
      soft: store.readFlag(FLAG_SOFT_CHECKPOINT, { currentLevel: level }) !== null,
      rotate: store.readFlag(FLAG_ROTATE_NOW, { currentLevel: level }) !== null,
      // Deliberately NOT level-checked. "Every account is out of weekly quota"
      // is not invalidated by the active account's binding window recovering —
      // a 5-hour window refilling says nothing about the week.
      allExhausted: store.readFlag(FLAG_ALL_EXHAUSTED) !== null,
    },
    pendingHandover: (() => {
      const pending = new PendingSwitchStore(store.dir).peek();
      if (pending === null || pending.dryRun) return null;
      return { slot: pending.slot, reason: pending.reason, expiresAt: pending.expiresAt };
    })(),
    lanes,
    unsavedTrees: lanes.length,
    scheduler: { detail: await schedulerStatus(config) },
    sessions,
  };
}

function bar(headroomPct: number, width = 20): string {
  const filled = Math.max(0, Math.min(width, Math.round((headroomPct / 100) * width)));
  return `${'#'.repeat(filled)}${'.'.repeat(width - filled)}`;
}

export function renderStatus(report: StatusReport, config: Config): string {
  const lines: string[] = [];
  const push = (s = '') => lines.push(s);

  push('rotorcc');
  push('');

  if (report.usage === null) {
    push(`  accounts     unreadable — ${report.usageError ?? 'unknown error'}`);
  } else {
    for (const account of report.usage.accounts) {
      const label = account.alias ?? account.email ?? `account ${account.number}`;
      const marker = account.active ? '>' : ' ';
      const resets =
        account.bindingResetsAt === undefined
          ? ''
          : ` · resets ${account.bindingResetsAt.slice(0, 16).replace('T', ' ')}`;
      push(
        `  ${marker} ${String(account.number).padEnd(2)} ${label.padEnd(28)} ${bar(account.headroomPct)} ${account.headroomPct.toFixed(0).padStart(3)}% left (${account.bindingWindow})${resets}`,
      );
    }
    push('');
    push(
      `  level        ${report.level}   (warn ${config.thresholds.warnPct}% · soft ${config.thresholds.softPct}% · rotate ${config.thresholds.rotatePct}%)`,
    );
  }

  push('');
  push(`  store        ${report.store.path}`);
  push(
    `               ${report.store.exists ? (report.store.lastCommit ?? 'no commits yet') : 'not created yet'}${report.store.lastCommitAt !== null ? ` (${ago(report.store.lastCommitAt)})` : ''}`,
  );
  push(`  snapshot     ${ago(report.lastSnapshotAt)}`);
  push(`  manifest     ${report.lastManifest ?? 'none written'}`);
  push(`  watcher      ${report.scheduler.detail}`);

  if (report.flags.rotate || report.flags.soft || report.flags.allExhausted) {
    push('');
    if (report.flags.allExhausted) {
      push('  STOPPED      every account is out of weekly quota; rotorcc will not rotate or start');
      push('               anything. Wait for a reset above, or: rotorcc accounts add');
    }
    if (report.flags.rotate) push('  FLAG         ROTATE_NOW is raised');
    if (report.flags.soft) push('  FLAG         SOFT_CHECKPOINT_REQUESTED is raised');
  }

  push('');
  if (report.pendingHandover !== null) {
    push(`  next session opens on slot ${report.pendingHandover.slot}`);
    push(`               ${report.pendingHandover.reason}`);
    push('               the running session keeps its own account; nothing is interrupted');
  } else {
    push('  next session opens on the current account (no handover queued)');
  }

  push('');
  if (report.lanes.length === 0) {
    push('  unsaved      nothing: every watched tree is clean and pushed');
  } else {
    push(`  unsaved      ${report.lanes.length} tree(s) hold work that is not on a remote:`);
    for (const lane of report.lanes) {
      push(
        `               ${lane.branch}${lane.protectedBranch ? ' (protected)' : ''}  +${lane.ahead ?? '?'} unpushed, ${lane.dirty} dirty  ${lane.tree}`,
      );
    }
  }

  if (report.sessions.length > 0) {
    push('');
    push('  sessions');
    for (const session of report.sessions) {
      push(
        `               ${session.sessionId.slice(0, 8)}  ${(session.bytes / 1024 / 1024).toFixed(1)} MB  last write ${ago(new Date(Date.now() - session.idleSeconds * 1000).toISOString())}`,
      );
    }
  }

  push('');
  return lines.join('\n');
}

export function storeSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

export function readJsonFile<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}
