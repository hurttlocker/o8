import { spawnSync, type SpawnSyncReturns } from 'node:child_process';

export interface CodingCommandReceipt {
  command: string;
  status: number | null;
  signal: string | null;
  durationMs: number;
  timedOut: boolean;
  stderrBytes: number;
  spawnErrorCode: string | null;
}

export function runCodingCommand(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): { receipt: CodingCommandReceipt; stdout: string; stderr: string } {
  const startedAt = Date.now();
  const result: SpawnSyncReturns<string> = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
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
