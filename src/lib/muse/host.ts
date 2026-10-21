import type { Connection, SpawnedMspConnection } from '@muse-code/sdk';
import { access, constants } from 'node:fs/promises';
import path from 'node:path';
import { executableSuffixes } from '@/lib/runtimes/shared/cli-locate';
import { cliInvocation } from '@/lib/runtimes/shared/cli-spawn';
import { scanForBinary } from '@/lib/runtimes/shared/cli-locate';

export interface MuseHost {
  connection: Pick<Connection, 'request' | 'command' | 'mintCommandId' | 'onNotification' | 'onServerRequest' | 'onProtocolError' | 'closed'>;
  initializeResult: SpawnedMspConnection['initializeResult'];
  close(): Promise<void>;
}

export interface MuseHostOptions { cwd: string; readOnly?: boolean; signal?: AbortSignal; binary?: string; timeoutMs?: number; configRoot?: string; dataRoot?: string }

export async function resolveMuseBinary(): Promise<string> {
  let binary = process.env.O8_MUSE_BIN?.trim();
  if (!binary) {
    for (const directory of (process.env.PATH ?? '').split(path.delimiter).filter(value => path.isAbsolute(value))) {
      for (const suffix of executableSuffixes()) {
        const candidate = path.join(directory, `muse${suffix}`);
        try { await access(candidate, constants.X_OK); binary = candidate; break; } catch { /* Read-only search continues. */ }
      }
      if (binary) break;
    }
  }
  binary ??= scanForBinary('muse') ?? undefined;
  if (!binary) throw new Error('Muse Code is not installed.');
  await access(binary, constants.X_OK);
  return binary;
}

/** Host processes use the CLI's own account; ambient API credentials never select another payer. */
export function museHostEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const omitted = new Set(['META_API_KEY', 'META_API_URL', 'META_BASE_URL', 'MUSE_AUTH_PATH', 'OPENROUTER_API_KEY', 'NODE_OPTIONS', 'MUSE_PERMISSION_PROFILE_FAIL_OPEN']);
  const sanitized = { ...environment };
  for (const key of Object.keys(sanitized)) if (omitted.has(key.toUpperCase())) delete sanitized[key];
  sanitized.MUSE_NO_AUTO_UPDATE = '1';
  return sanitized;
}

export async function boundedMuseRequest<T>(promise: Promise<T>, host: Pick<MuseHost, 'close'>, timeoutMs = 20_000): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timeout = setTimeout(() => { void host.close().catch(() => {}); reject(new Error('Muse did not respond in time. Retry the connection.')); }, timeoutMs);
      timeout.unref();
    })]);
  } finally { clearTimeout(timeout); }
}

export async function createMuseHost(options: MuseHostOptions): Promise<MuseHost> {
  options.signal?.throwIfAborted();
  const binary = options.binary ?? await resolveMuseBinary();
  options.signal?.throwIfAborted();
  const { spawnMspConnection } = await import('@muse-code/sdk');
  const invocation = cliInvocation(binary, ['serve', '--provider', 'meta', ...(options.readOnly ? ['--disable-shell', '--disable-write'] : [])]);
  const pending = spawnMspConnection({ ...invocation, cwd: options.cwd,
    env: { ...museHostEnvironment(), ...(options.configRoot ? { XDG_CONFIG_HOME: options.configRoot } : {}),
      ...(options.dataRoot ? { XDG_DATA_HOME: options.dataRoot } : {}) },
    shutdownTimeoutMs: 1_000, connection: { frameLimitBytes: 6 * 1024 * 1024 } });
  let closing: Promise<void> | undefined;
  const close = () => closing ??= pending.close().then(() => undefined);
  const abort = () => { void close().catch(() => {}); };
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  try {
    const host = await boundedMuseRequest(pending.initialize({ clientInfo: { name: 'o8', version: '1' }, capabilities: { requestedCapabilities: ['sessionMcp'], userInputDialogs: false } }), { close }, options.timeoutMs);
    options.signal?.throwIfAborted();
    if (host.initializeResult.schema.version !== 1) throw new Error('Muse uses an unsupported session protocol.');
    options.signal?.removeEventListener('abort', abort);
    return { connection: host.connection, initializeResult: host.initializeResult, close: async () => {
      options.signal?.removeEventListener('abort', abort);
      await close();
    } };
  } catch (error) {
    options.signal?.removeEventListener('abort', abort);
    await close();
    throw error;
  }
}
