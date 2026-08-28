import { afterEach, describe, expect, it, vi } from 'vitest';

import { routeUiLoopEdit } from './ui-loop-edit';

const context = {
  text: 'Edit the selected browser element.\nSelector: #save',
  previewImageDataUri: 'data:image/png;base64,element-crop',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('routeUiLoopEdit', () => {
  it('steers the resolved warm packet without invoking the composer fallback', async () => {
    const injectFallback = vi.fn();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({
        ok: true,
        result: {
          packetId: 'pkt-warm',
          laneId: 'lane-warm',
          lastActivityAt: '2026-08-28T08:00:00.000Z',
          label: '#1905',
        },
      }))
      .mockResolvedValueOnce(Response.json({
        ok: true,
        result: {
          kind: 'steered',
          packet: {
            packetId: 'pkt-warm',
            laneId: 'lane-warm',
            lastActivityAt: '2026-08-28T08:00:00.000Z',
            label: '#1905',
          },
        },
      }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(routeUiLoopEdit({
      repoPath: '/repo/o8',
      context,
      forceFresh: false,
      injectFallback,
    })).resolves.toMatchObject({
      kind: 'steered',
      packet: { packetId: 'pkt-warm', laneId: 'lane-warm' },
    });
    expect(injectFallback).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/orchestrator/ui-loop?repo=%2Frepo%2Fo8');
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({
      repo: '/repo/o8',
      text: context.text,
      previewImageDataUri: context.previewImageDataUri,
    });
  });

  it('uses the existing composer path immediately when Option forces a fresh turn', async () => {
    const injectFallback = vi.fn();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(routeUiLoopEdit({
      repoPath: '/repo/o8',
      context,
      forceFresh: true,
      injectFallback,
    })).resolves.toEqual({ kind: 'fallback', reason: 'FORCED_FRESH' });
    expect(injectFallback).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses the existing composer path when no warm packet exists', async () => {
    const injectFallback = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ ok: true, result: null })));

    await expect(routeUiLoopEdit({
      repoPath: '/repo/o8',
      context,
      forceFresh: false,
      injectFallback,
    })).resolves.toEqual({ kind: 'fallback', reason: 'NO_WARM_UI_LOOP_PACKET' });
    expect(injectFallback).toHaveBeenCalledTimes(1);
  });

  it('does not dispatch a fallback turn when the steer response is lost', async () => {
    const injectFallback = vi.fn();
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(Response.json({
        ok: true,
        result: {
          packetId: 'pkt-warm',
          laneId: 'lane-warm',
          lastActivityAt: '2026-08-28T08:00:00.000Z',
          label: '#1905',
        },
      }))
      .mockRejectedValueOnce(new Error('connection closed')));

    await expect(routeUiLoopEdit({
      repoPath: '/repo/o8',
      context,
      forceFresh: false,
      injectFallback,
    })).resolves.toMatchObject({
      kind: 'error',
      message: expect.stringContaining('Check the running packet before retrying'),
    });
    expect(injectFallback).not.toHaveBeenCalled();
  });

  it('returns blocked budget details with the packet needed by Open packet', async () => {
    const injectFallback = vi.fn();
    const packet = {
      packetId: 'pkt-warm',
      laneId: 'lane-warm',
      lastActivityAt: '2026-08-28T08:00:00.000Z',
      label: '#1905',
    };
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(Response.json({ ok: true, result: packet }))
      .mockResolvedValueOnce(Response.json({
        ok: true,
        result: {
          blocked: 'iterations',
          values: { iterations: 8 },
          packet,
        },
      })));

    await expect(routeUiLoopEdit({
      repoPath: '/repo/o8',
      context,
      forceFresh: false,
      injectFallback,
    })).resolves.toEqual({ kind: 'blocked', packet, reason: 'iterations' });
    expect(injectFallback).not.toHaveBeenCalled();
  });
});
