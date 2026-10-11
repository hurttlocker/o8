import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  apiFetch,
  DEFAULT_API_TIMEOUT_MS,
  EXIT,
  CliError,
} from '../cli/src/api';
import type { ResolvedConfig } from '../cli/src/config';
import { printError } from '../cli/src/output';

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
      exit: EXIT.SERVER_TIMEOUT,
      ambiguous: true,
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

  it('serializes server_timeout as an ambiguous outcome with its own exit code', async () => {
    rejectFetch(errorWithCause('ETIMEDOUT'));
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    let timeoutError: unknown;
    try {
      await apiFetch(config, '/api/orchestrator/merge');
    } catch (error) {
      timeoutError = error;
    }

    expect(printError(timeoutError, { human: false, verbose: false })).toBe(EXIT.SERVER_TIMEOUT);
    const payload = JSON.parse(stderr.mock.calls.map(([chunk]) => String(chunk)).join(''));
    expect(payload).toMatchObject({
      schema: 'o8/cli/error/v1',
      error: {
        code: 'server_timeout',
        ambiguous: true,
      },
    });
  });

  it('keeps definitive state conflicts on exit 5 with an unambiguous outcome', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ note: 'already merged' }), {
      status: 409,
      headers: { 'Content-Type': 'application/json' },
    })));

    await expect(apiFetch(config, '/api/orchestrator/merge')).rejects.toMatchObject({
      code: 'conflict',
      exit: EXIT.CONFLICT,
      ambiguous: false,
    });
  });

  it('returns structured conflict details when a command opts into handling them', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ok: false,
      error: { code: 'update_apply_busy' },
      idle: { active: { lanes: [{ id: 'lane-live' }] } },
    }), {
      status: 409,
      headers: { 'Content-Type': 'application/json' },
    })));

    const response = await apiFetch<Record<string, unknown>>(config, '/api/panel/update/apply', {
      method: 'POST',
      body: { force: false },
      allowConflict: true,
    });
    expect(response.status).toBe(409);
    expect(response.data).toMatchObject({ error: { code: 'update_apply_busy' } });
  });
});


describe('CLI authorization refusal details', () => {
  it.each([
    { error: 'Safe server refusal.\n' },
    { error: { code: 'spectator_scope_denied', message: 'Safe server refusal.\n' } },
  ])('retains bounded string/structured reasons and spectator grant guidance', async body => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status: 403 })));
    await expect(apiFetch({ ...config, source: { port: 'env', token: 'spectator' } }, '/api/lanes'))
      .rejects.toMatchObject({
        code: 'forbidden', exit: EXIT.UNAUTHORIZED,
        message: 'Server refused this operation (403): Safe server refusal. ',
        hint: 'Check O8_SPECTATOR_TOKEN and the repository grants attached to that bearer.',
      });
  });

  it('keeps worker hints packet-scoped even when the server supplies a spectator code', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      error: { code: 'spectator_scope_denied', message: 'Capability refused.' },
    }), { status: 403 })));
    await expect(apiFetch({ ...config, source: { port: 'env', token: 'worker' } }, '/api/lanes'))
      .rejects.toMatchObject({ code: 'forbidden', hint: expect.stringContaining('assigned packet') });
  });

  it('bounds refusal text and omits unknown object fields', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      error: { message: 'x'.repeat(1000), unrelated: 'not-a-refusal-detail' },
    }), { status: 403 })));
    try {
      await apiFetch(config, '/api/lanes');
      throw new Error('Expected refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).message.length).toBeLessThan(350);
      expect((error as CliError).message).not.toContain('not-a-refusal-detail');
      expect((error as CliError).hint).not.toMatch(/O8_API_TOKEN|ws-token|refresh/i);
    }
  });
});
