/**
 * Subprocess execution.
 *
 * Everything runs through `execFile` with an argv array and `shell: false`.
 * rotorcc runs on a machine where a config file it did not write names the
 * programs it calls, so a string command line handed to a shell would be a
 * command-injection hole with extra steps.
 *
 * On Windows, `execFile` cannot launch a `.cmd`/`.bat` shim (npm installs
 * `git.cmd`-style wrappers, and `gh` is often one). `resolveWindowsShim` finds
 * the real executable on PATH so the argv array survives intact instead of
 * being re-quoted by cmd.exe.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface RunResult {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
  /** Set when the process could not be started or was killed by a timeout. */
  error?: string;
}

export interface RunOptions {
  cwd?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  maxBuffer?: number;
  /** Treat these non-zero exit codes as success (git uses 1 for "no output"). */
  okCodes?: number[];
}

const WINDOWS_EXTENSIONS = ['.exe', '.cmd', '.bat', '.com'];

/**
 * Resolve a bare command name to an absolute path on Windows. Returns the
 * input unchanged elsewhere, and unchanged when nothing matches (letting the
 * OS produce its own ENOENT, which is a clearer message than ours).
 */
export function resolveWindowsShim(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  isWindows = process.platform === 'win32',
): string {
  if (!isWindows) return command;
  if (command.includes('/') || command.includes('\\')) return command;
  const pathValue = env.PATH ?? env.Path ?? '';
  for (const dir of pathValue.split(delimiter).filter((d) => d !== '')) {
    for (const ext of WINDOWS_EXTENSIONS) {
      const candidate = join(dir, `${command}${ext}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return command;
}

export async function run(argv: string[], options: RunOptions = {}): Promise<RunResult> {
  const [head, ...rest] = argv;
  if (head === undefined) {
    return { ok: false, code: -1, stdout: '', stderr: '', error: 'empty command' };
  }
  const command = resolveWindowsShim(head, options.env ?? process.env);
  const spawnOptions = {
    cwd: options.cwd,
    timeout: options.timeoutMs ?? 60_000,
    env: options.env ?? process.env,
    maxBuffer: options.maxBuffer ?? 32 * 1024 * 1024,
    windowsHide: true,
    encoding: 'utf8' as const,
  };

  try {
    const { stdout, stderr } = await execFileAsync(command, rest, spawnOptions);
    return { ok: true, code: 0, stdout, stderr };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      code?: number | string;
      killed?: boolean;
    };
    const numericCode = typeof e.code === 'number' ? e.code : -1;
    const ok = options.okCodes?.includes(numericCode) ?? false;
    return {
      ok,
      code: numericCode,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
      ...(ok
        ? {}
        : {
            error:
              e.killed === true
                ? `timed out after ${spawnOptions.timeout}ms`
                : typeof e.code === 'string'
                  ? `${e.code}: ${e.message}`
                  : e.message,
          }),
    };
  }
}

/** True when the command exists and answers `--version` (or any exit code). */
export async function commandExists(argv: string[], timeoutMs = 8_000): Promise<boolean> {
  const result = await run([...argv, '--version'], { timeoutMs, okCodes: [1, 2, 64, 127] });
  return result.error === undefined || !result.error.startsWith('ENOENT');
}
