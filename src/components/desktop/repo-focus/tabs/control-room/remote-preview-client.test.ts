import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectRemotePreview } from './remote-preview-client';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('durable review preview connection', () => {
  it('polls the same service session until ready without requesting a new deadline', async () => {
    vi.useFakeTimers();
    const request = vi.fn().mockResolvedValueOnce(Response.json({ serviceJobId: 'service-1', expiresAt: 'fixed' }, { status: 202 }))
      .mockResolvedValueOnce(Response.json({ id: 'listener', url: 'http://[::1]:1234/', serviceJobId: 'service-1', expiresAt: 'fixed' }));
    vi.stubGlobal('fetch', request);
    const onAccess = vi.fn();
    const promise = connectRemotePreview({ endpoint: '/preview', jobId: 'completed-1', attempt: 1,
      signal: new AbortController().signal, onAccess });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await promise).toMatchObject({ id: 'listener', serviceJobId: 'service-1', expiresAt: 'fixed' });
    expect(JSON.parse(request.mock.calls[1]![1].body)).toEqual({ jobId: 'completed-1', attempt: 1, serviceJobId: 'service-1' });
    expect(onAccess).toHaveBeenCalledTimes(2);
  });

  it('returns a late allocated session to cleanup when the pane closes during the request', async () => {
    const controller = new AbortController();
    let finish!: (response: Response) => void;
    vi.stubGlobal('fetch', () => new Promise<Response>((resolve) => { finish = resolve; }));
    const onAccess = vi.fn();
    const promise = connectRemotePreview({ endpoint: '/preview', jobId: 'completed-1', attempt: 1, signal: controller.signal, onAccess });
    const rejected = expect(promise).rejects.toThrow('Preview closed');
    controller.abort();
    finish(Response.json({ serviceJobId: 'late-service' }, { status: 202 }));
    await rejected;
    expect(onAccess).toHaveBeenCalledWith({ serviceJobId: 'late-service' });
  });
});
