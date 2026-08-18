/**
 * Logging, with redaction applied on the way out.
 *
 * The log is the one artefact an operator pastes into an issue, so it gets the
 * same screen the mirror does. Account emails are left alone deliberately: they
 * are how you tell accounts apart, they are not credentials, and masking them
 * would make every rotation line unreadable.
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

import { DEFAULT_PATTERNS } from './secrets.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function redact(text: string): string {
  let out = text;
  for (const pattern of DEFAULT_PATTERNS) {
    const global = new RegExp(pattern.regex.source, `${pattern.regex.flags.replace('g', '')}g`);
    out = out.replace(global, `[redacted:${pattern.id}]`);
  }
  return out;
}

export interface LoggerOptions {
  file?: string;
  level?: LogLevel;
  /** Also write to stderr. Off for hooks, on for interactive commands. */
  console?: boolean;
  maxBytes?: number;
  json?: boolean;
}

export class Logger {
  private readonly file: string;
  private readonly level: LogLevel;
  private readonly toConsole: boolean;
  private readonly maxBytes: number;

  constructor(options: LoggerOptions = {}) {
    this.file = options.file ?? '';
    this.level = options.level ?? 'info';
    this.toConsole = options.console ?? false;
    this.maxBytes = options.maxBytes ?? 8 * 1024 * 1024;
  }

  private rotateIfBig(): void {
    if (this.file === '' || this.maxBytes <= 0) return;
    try {
      const size = statSync(this.file).size;
      if (size > this.maxBytes) renameSync(this.file, `${this.file}.1`);
    } catch {
      /* no log file yet, or a filesystem that will not stat it */
    }
  }

  log(level: LogLevel, message: string, fields: Record<string, unknown> = {}): void {
    if (ORDER[level] < ORDER[this.level]) return;
    const at = new Date().toISOString();
    const extra = Object.keys(fields).length > 0 ? ` ${redact(JSON.stringify(fields))}` : '';
    const line = `${at} ${level.toUpperCase().padEnd(5)} ${redact(message)}${extra}\n`;

    if (this.file !== '') {
      try {
        this.rotateIfBig();
        mkdirSync(dirname(this.file), { recursive: true });
        appendFileSync(this.file, line, 'utf8');
      } catch {
        // A log that cannot be written must never take the run down with it.
      }
    }
    if (this.toConsole) process.stderr.write(line);
  }

  debug(message: string, fields?: Record<string, unknown>): void {
    this.log('debug', message, fields ?? {});
  }
  info(message: string, fields?: Record<string, unknown>): void {
    this.log('info', message, fields ?? {});
  }
  warn(message: string, fields?: Record<string, unknown>): void {
    this.log('warn', message, fields ?? {});
  }
  error(message: string, fields?: Record<string, unknown>): void {
    this.log('error', message, fields ?? {});
  }
}

export const silentLogger = new Logger({ level: 'error' });
