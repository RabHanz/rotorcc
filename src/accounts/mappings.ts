/**
 * Directory → account bindings.
 *
 * "This repository always runs on that account." Useful for the obvious reason
 * (a client's work bills to the client's subscription) and for a less obvious
 * one that matters more here: a mapped directory is a directory whose account
 * the rotation policy should not silently change.
 *
 * Longest-prefix wins, so a mapping on `~/work` is inherited by everything
 * under it while `~/work/client-b` can override it. Resolution is by real path,
 * so a symlinked checkout resolves to the same mapping as the directory it
 * points at — otherwise the binding silently stops applying depending on how
 * the operator happened to `cd` there.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

import { z } from 'zod';

import { writeJsonAtomic } from './atomic.js';

const mappingSchema = z.object({
  version: z.literal(1).default(1),
  /** Absolute, real path to slot number. */
  paths: z.record(z.string(), z.number().int()).default({}),
});

export type MappingFile = z.infer<typeof mappingSchema>;

export class MappingStore {
  readonly path: string;

  constructor(readonly accountsDir: string) {
    this.path = join(accountsDir, 'mappings.json');
  }

  read(): MappingFile {
    if (!existsSync(this.path)) return { version: 1, paths: {} };
    try {
      const parsed = mappingSchema.safeParse(JSON.parse(readFileSync(this.path, 'utf8')));
      return parsed.success ? parsed.data : { version: 1, paths: {} };
    } catch {
      return { version: 1, paths: {} };
    }
  }

  write(file: MappingFile): void {
    writeJsonAtomic(this.path, file);
  }

  set(directory: string, slot: number): string {
    const key = canonical(directory);
    const file = this.read();
    file.paths[key] = slot;
    this.write(file);
    return key;
  }

  unset(directory: string): boolean {
    const key = canonical(directory);
    const file = this.read();
    if (file.paths[key] === undefined) return false;
    delete file.paths[key];
    this.write(file);
    return true;
  }

  list(): Array<{ path: string; slot: number }> {
    return Object.entries(this.read().paths)
      .map(([path, slot]) => ({ path, slot }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  /**
   * The slot bound to `directory`, following the longest matching prefix.
   *
   * Returns null rather than a default. A directory with no mapping is not a
   * directory mapped to account 1.
   */
  resolve(directory: string): { slot: number; via: string } | null {
    const target = canonical(directory);
    const file = this.read();
    let best: { slot: number; via: string } | null = null;
    for (const [prefix, slot] of Object.entries(file.paths)) {
      if (!isWithin(target, prefix)) continue;
      if (best === null || prefix.length > best.via.length) best = { slot, via: prefix };
    }
    return best;
  }
}

/**
 * An absolute, symlink-resolved path.
 *
 * `realpathSync` can fail on a directory that does not exist yet, which is a
 * legitimate thing to map ahead of time — falling back to `resolve` keeps that
 * working instead of throwing at the operator.
 */
export function canonical(directory: string): string {
  const absolute = resolve(directory);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

/** Whether `target` is `prefix` or lives under it. */
export function isWithin(target: string, prefix: string): boolean {
  if (target === prefix) return true;
  // The separator check is what stops `/home/u/proj-old` matching a mapping on
  // `/home/u/proj`.
  return target.startsWith(prefix.endsWith(sep) ? prefix : prefix + sep);
}
