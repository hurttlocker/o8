import { spawnSync, type SpawnSyncReturns } from 'node:child_process';

import type { ArmErrorReceipt } from './coding-arm-outcome';

const MAX_DIFF_BYTES = 32 * 1024 * 1024;
const MAX_READ_ATTEMPTS = 3;
const READ_RETRY_DELAY_MS = 5_000;

export interface EndToEndCommandReceipt {
  command: string;
  status: number | null;
  signal: string | null;
  durationMs: number;
  timedOut: boolean;
  stderrBytes: number;
  spawnErrorCode: string | null;
}

export interface EndToEndCommandResult {
  receipt: EndToEndCommandReceipt;
  stdout: string;
  stderr: string;
}

export interface DiffFacts {
  changedFiles: string[];
  additions: number;
  deletions: number;
}

export function runEndToEndCommand(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): EndToEndCommandResult {
  const startedAt = Date.now();
  const result: SpawnSyncReturns<string> = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    maxBuffer: MAX_DIFF_BYTES,
    timeout: options.timeoutMs,
  });
  const errorCode = result.error && 'code' in result.error ? String(result.error.code) : '';
  return {
    receipt: {
      command: command === 'ginsu' && args[0] === 'send'
        ? `ginsu send ${args[1] ?? '(unknown)'} <PROMPT>`
        : [command, ...args].join(' '),
      status: result.status,
      signal: result.signal,
      durationMs: Date.now() - startedAt,
      timedOut: errorCode === 'ETIMEDOUT',
      stderrBytes: Buffer.byteLength(result.stderr || '', 'utf8'),
      spawnErrorCode: errorCode || null,
    },
    stdout: result.stdout || '',
    stderr: result.stderr || result.error?.message || '',
  };
}

export function emptyEndToEndCommand(command: string): EndToEndCommandReceipt {
  return {
    command,
    status: null,
    signal: null,
    durationMs: 0,
    timedOut: false,
    stderrBytes: 0,
    spawnErrorCode: null,
  };
}

export function parseEndToEndJson<T>(text: string, label: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${label} returned malformed JSON`);
  }
}

function waitBeforeReadRetry(): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, READ_RETRY_DELAY_MS);
}

export function jsonCommandWithReadRetries<T>(
  command: string,
  args: string[],
  cwd: string,
  label: string,
): EndToEndCommandResult & { data: T | null; errors: ArmErrorReceipt[] } {
  let result: EndToEndCommandResult = {
    receipt: emptyEndToEndCommand([command, ...args].join(' ')),
    stdout: '',
    stderr: '',
  };
  const errors: ArmErrorReceipt[] = [];
  for (let attempt = 0; attempt < MAX_READ_ATTEMPTS; attempt += 1) {
    result = runEndToEndCommand(command, args, { cwd, timeoutMs: 60_000 });
    let message: string | null = null;
    if (result.receipt.status === 0) {
      try {
        return { ...result, data: parseEndToEndJson<T>(result.stdout, label), errors };
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
    } else {
      message = `${label} failed with status ${result.receipt.status ?? 'not observed'}`;
    }
    errors.push({ message, willRetry: attempt + 1 < MAX_READ_ATTEMPTS });
    if (attempt + 1 < MAX_READ_ATTEMPTS) waitBeforeReadRetry();
  }
  return { ...result, data: null, errors };
}

export function diffFactsFromUnifiedDiff(diff: string): DiffFacts {
  const files = new Set<string>();
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split('\n')) {
    const header = line.match(/^diff --git a\/(.+) b\/(.+)$/);
    if (header?.[2]) files.add(header[2]);
    else if (line.startsWith('+') && !line.startsWith('+++')) additions += 1;
    else if (line.startsWith('-') && !line.startsWith('---')) deletions += 1;
  }
  return { changedFiles: [...files], additions, deletions };
}
