import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  apiFetch,
  DEFAULT_API_TIMEOUT_MS,
  type CliError,
} from '../cli/src/api';
import type { ResolvedConfig } from '../cli/src/config';

const config: ResolvedConfig = {
  apiPort: 47120,
  apiBase: 'http://127.0.0.1:47120',
  token: null,
  workerPacketId: null,
  source: { port: 'default', token: 'none' },
  dataDir: null,
};

function errorWithCause(code: string, message = 'fetch failed'): Error {
  return Object.assign(new TypeError(message), { cause: { code } });
}

function rejectFetch(error: unknown): void {
  vi.stubGlobal('fetch', vi.fn(async () => {
    throw error;
  }));
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('CLI apiFetch network error taxonomy', () => {
  it('maps only a real ECONNREFUSED transport failure to connection_refused', async () => {
    rejectFetch(errorWithCause('ECONNREFUSED'));

    await expect(apiFetch(config, '/api/lanes')).rejects.toMatchObject({
      code: 'connection_refused',
      message: expect.stringContaining('refused the TCP connection'),
    });
  });

  it('recognizes ECONNREFUSED when undici includes it only in the message', async () => {
    rejectFetch(new TypeError('connect ECONNREFUSED 127.0.0.1:47120'));

    await expect(apiFetch(config, '/api/lanes')).rejects.toMatchObject({
      code: 'connection_refused',
    });
  });

  it.each([
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_BODY_TIMEOUT',
    'ETIMEDOUT',
  ])('maps %s to server_timeout instead of connection_refused', async (code) => {
    rejectFetch(errorWithCause(code));

    await expect(apiFetch(config, '/api/lanes', { timeoutMs: 42_000 })).rejects.toMatchObject({
      code: 'server_timeout',
      message: 'o8 app accepted the connection but /api/lanes did not answer within 42s.',
      hint: expect.stringContaining('server route is stalled, not unreachable'),
    });
  });

  it.each(['TimeoutError', 'AbortError'])('maps a %s DOMException to server_timeout', async (name) => {
    rejectFetch(new DOMException('request expired', name));

    await expect(apiFetch(config, '/api/lanes')).rejects.toMatchObject({
      code: 'server_timeout',
      message: expect.stringContaining('within 120s'),
    });
  });

  it('maps a generic fetch failed rejection to network_error', async () => {
    rejectFetch(new TypeError('fetch failed'));

    await expect(apiFetch(config, '/api/lanes')).rejects.toMatchObject({
      code: 'network_error',
      message: expect.stringContaining('fetch failed'),
    });
  });

  it('includes the undici cause code in an unknown network error', async () => {
    rejectFetch(errorWithCause('ECONNRESET', 'socket closed'));

    await expect(apiFetch(config, '/api/lanes')).rejects.toMatchObject({
      code: 'network_error',
      message: expect.stringContaining('(ECONNRESET)'),
    });
  });

  it('applies the 120-second timeout by default', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    rejectFetch(errorWithCause('UND_ERR_HEADERS_TIMEOUT'));

    await expect(apiFetch(config, '/api/lanes')).rejects.toMatchObject({ code: 'server_timeout' });
    expect(timeoutSpy).toHaveBeenCalledWith(DEFAULT_API_TIMEOUT_MS);
  });

  it('aborts the complete request at a caller-provided timeout', async () => {
    vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, init?: RequestInit) => (
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) {
          reject(new Error('missing abort signal'));
          return;
        }
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      })
    )));

    try {
      await apiFetch(config, '/api/slow-route', { timeoutMs: 20 });
      throw new Error('expected apiFetch to time out');
    } catch (error) {
      expect((error as CliError).code).toBe('server_timeout');
      expect((error as CliError).message).toContain('/api/slow-route did not answer within 0.02s');
    }
  });

  it('maps response-body timeout failures through the same taxonomy', async () => {
    const response = new Response('{}', { status: 200 });
    vi.spyOn(response, 'text').mockRejectedValue(errorWithCause('UND_ERR_BODY_TIMEOUT'));
    vi.stubGlobal('fetch', vi.fn(async () => response));

    await expect(apiFetch(config, '/api/body-stalled')).rejects.toMatchObject({
      code: 'server_timeout',
      message: expect.stringContaining('/api/body-stalled'),
    });
  });
});
