import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventStream, isTransientTransportError, type CloudWorkerJob } from '../scripts/worker/event-stream';
import { HeartbeatAuthorityExpired, renewServiceHeartbeat } from '../scripts/worker/service-heartbeat';

const job = { id: 'service-fixture', leaseToken: 'owned-claim' } as CloudWorkerJob;
const stream = new EventStream({ o8Url: 'http://fixture.invalid', workerKey: 'cwk_fixture', workerId: 'owned-worker' });
const transport = (code = 'UND_ERR_SOCKET') => new TypeError('fetch failed', { cause: { code } });
const options = () => ({ signal: new AbortController().signal, confirmedUntil: Date.now() + 5_000 });
const acknowledgement = () => Response.json({ leaseExpiresAt: new Date(Date.now() + 15_000).toISOString() });

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('service heartbeat transport recovery', () => {
  it.each(['UND_ERR_SOCKET', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'UND_ERR_BODY_TIMEOUT'])('recognizes explicit %s transport evidence', (code) => {
    expect(isTransientTransportError(transport(code))).toBe(true);
  });

  it.each([
    new TypeError('fetch failed'), new Error('ECONNRESET mentioned by a product error'),
    transport('CERT_HAS_EXPIRED'), new SyntaxError('invalid JSON'),
    new DOMException('cancelled', 'AbortError'), new DOMException('timeout', 'TimeoutError'),
  ])('does not classify refusal, malformed or untyped errors by their message: %s', (error) => {
    expect(isTransientTransportError(error)).toBe(false);
  });

  it('starts a fresh claim-bound heartbeat after transport loss without replaying generic POST events', async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(transport()).mockResolvedValueOnce(acknowledgement());
    vi.stubGlobal('fetch', fetchMock);
    expect(await renewServiceHeartbeat(stream, job, options())).toBeTypeOf('string');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [url, init] of fetchMock.mock.calls) {
      expect(url).toBe('http://fixture.invalid/api/cloud/worker-stream');
      expect(JSON.parse(init.body)).toEqual({ jobId: job.id, workerId: 'owned-worker', leaseToken: job.leaseToken,
        type: 'heartbeat', payload: { status: 'running' } });
    }
    fetchMock.mockReset().mockRejectedValue(transport());
    await expect(stream.postEvent(job, 'chunk', { text: 'one output' })).rejects.toThrow('fetch failed');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retains generic GET message-based retries while service heartbeats reject untyped transport errors', async () => {
    const error = new TypeError('fetch failed');
    const fetchMock = vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await stream.pollControl(job)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.every(([, init]) => init.method === 'GET')).toBe(true);
    fetchMock.mockReset().mockRejectedValue(error);
    await expect(renewServiceHeartbeat(stream, job, options())).rejects.toBe(error);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockClear();
    await expect(stream.postEvent(job, 'chunk', { text: 'single attempt' })).rejects.toBe(error);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403, 409, 503])('does not recover HTTP %s', async (status) => {
    const fetchMock = vi.fn(async () => new Response(null, { status }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(renewServiceHeartbeat(stream, job, options())).rejects.toThrow(`HTTP ${status}`);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry malformed JSON', async () => {
    const fetchMock = vi.fn(async () => new Response('{bad'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(renewServiceHeartbeat(stream, job, options())).rejects.toBeInstanceOf(SyntaxError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('caps consecutive fresh renewals and retains the first transport cause', async () => {
    const first = transport('ECONNRESET');
    const fetchMock = vi.fn().mockRejectedValueOnce(first).mockRejectedValue(transport('ECONNREFUSED'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(renewServiceHeartbeat(stream, job, options())).rejects.toMatchObject({
      message: 'fetch failed; heartbeat transport recovery exhausted after 3 attempts', cause: first,
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not start a request after confirmed authority expires', async () => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    await expect(renewServiceHeartbeat(stream, job, { ...options(), confirmedUntil: Date.now() - 1 }))
      .rejects.toBeInstanceOf(HeartbeatAuthorityExpired);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an acknowledgement arriving after the old authority bound', async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    const fetchMock = vi.fn(async () => {
      const response = Response.json({ leaseExpiresAt: new Date(now + 60_000).toISOString() });
      clock.mockReturnValue(now + 5_001);
      return response;
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(renewServiceHeartbeat(stream, job, { ...options(), confirmedUntil: now + 5_000 }))
      .rejects.toBeInstanceOf(HeartbeatAuthorityExpired);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('cancels backoff at the old confirmed bound despite a possibly persisted renewal', async () => {
    vi.useFakeTimers();
    const first = transport();
    const fetchMock = vi.fn(async () => { throw first; }); vi.stubGlobal('fetch', fetchMock);
    const result = expect(renewServiceHeartbeat(stream, job, { ...options(), confirmedUntil: Date.now() + 40 }))
      .rejects.toMatchObject({ name: 'HeartbeatAuthorityExpired', cause: first });
    await vi.advanceTimersByTimeAsync(40);
    await result;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('shutdown cancels recovery backoff without another request', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(async () => { throw transport(); }); vi.stubGlobal('fetch', fetchMock);
    await expect(renewServiceHeartbeat(stream, job, { ...options(), signal: controller.signal,
      onTransportFailure: () => controller.abort(new Error('shutdown fixture')) })).rejects.toThrow('shutdown fixture');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('cancels an in-flight hung renewal on shutdown', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn((_url, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
      controller.abort(new Error('shutdown fixture'));
    }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(renewServiceHeartbeat(stream, job, { ...options(), signal: controller.signal })).rejects.toThrow('shutdown fixture');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a hung acknowledgement cannot consume more than the old confirmed authority', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_url, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    vi.stubGlobal('fetch', fetchMock);
    const result = expect(renewServiceHeartbeat(stream, job, { ...options(), confirmedUntil: Date.now() + 40 }))
      .rejects.toBeInstanceOf(HeartbeatAuthorityExpired);
    await vi.advanceTimersByTimeAsync(40);
    await result;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
