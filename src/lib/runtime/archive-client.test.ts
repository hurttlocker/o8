import { afterEach, describe, expect, it, vi } from 'vitest';
import { archiveRuntimeTarget } from './archive-client';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('archiveRuntimeTarget', () => {
  it('reuses one body and mutation id through transport uncertainty and a 202 receipt', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('connection reset'))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        archived: false,
        inProgress: true,
        status: 'in_progress',
      }), { status: 202 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        archived: true,
        sessionKey: 'codex-owned:archive-once',
        clientMutationId: 'archive-mutation-1',
      }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const pending = archiveRuntimeTarget(
      { sessionKey: 'codex-owned:archive-once' },
      'archive-mutation-1',
    );
    await vi.advanceTimersByTimeAsync(1_500);
    await expect(pending).resolves.toMatchObject({ archived: true });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0]).toEqual(fetchMock.mock.calls[2]);
    expect(JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body))).toEqual({
      sessionKey: 'codex-owned:archive-once',
      clientMutationId: 'archive-mutation-1',
    });
  });

  it('rejects a successful HTTP response that did not confirm archival', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: false,
      archived: false,
      note: 'The session is still active.',
    }), { status: 200 })));

    await expect(archiveRuntimeTarget(
      { sessionKey: 'codex-owned:still-active' },
      'archive-mutation-2',
    )).rejects.toThrow('The session is still active.');
  });

  it('rejects non-success responses with the route error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: 'Archive was rejected.',
    }), { status: 409 })));

    await expect(archiveRuntimeTarget(
      { laneId: 'lane-running' },
      'archive-mutation-3',
    )).rejects.toThrow('Archive was rejected.');
  });
});
