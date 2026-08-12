import { afterEach, describe, expect, it, vi } from 'vitest';
import { interruptRuntimeSurface } from './runtimeInterrupt';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('interruptRuntimeSurface', () => {
  it('reuses one correlated body through an ambiguous transport response', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('connection reset'))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        action: 'interrupt',
        status: 'completed',
      }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const request = interruptRuntimeSurface('codex-owned:interrupt-retry');
    await vi.advanceTimersByTimeAsync(750);
    await request;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const bodies = fetchMock.mock.calls.map(([, init]) => String((init as RequestInit).body));
    expect(bodies[0]).toBe(bodies[1]);
    expect(JSON.parse(bodies[0])).toMatchObject({
      action: 'interrupt',
      surfaceId: 'codex-owned:interrupt-retry',
      clientMutationId: expect.any(String),
    });
  });

  it('coalesces concurrent interrupts for the same runtime surface', async () => {
    let respond!: (response: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => { respond = resolve; }));
    vi.stubGlobal('fetch', fetchMock);

    const first = interruptRuntimeSurface('codex-owned:interrupt-concurrent');
    const second = interruptRuntimeSurface('codex-owned:interrupt-concurrent');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    respond(new Response(JSON.stringify({
      ok: true,
      action: 'interrupt',
      status: 'completed',
    }), { status: 200 }));

    await Promise.all([first, second]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
