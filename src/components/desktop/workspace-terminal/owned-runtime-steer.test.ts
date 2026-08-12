import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  fetchOwnedRuntimeSteerReceipt,
  ownedRuntimeCanAcceptInput,
  shouldHoldOwnedRuntimeSteer,
} from './owned-runtime-steer';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('owned runtime steer queue', () => {
  it('holds a retryable surface-not-ready response instead of rendering a failed attempt', () => {
    expect(shouldHoldOwnedRuntimeSteer(false, {
      ok: false,
      retryable: true,
      reason: 'surface_not_ready',
    })).toBe(true);

    expect(shouldHoldOwnedRuntimeSteer(false, {
      ok: false,
      retryable: false,
      reason: 'surface_not_ready',
    })).toBe(false);
  });

  it('requires the exact owned surface send-input capability before auto-delivery', () => {
    expect(ownedRuntimeCanAcceptInput([
      {
        sessionKey: 'codex-owned:active',
        runtimeSurface: {
          id: 'codex-owned:active',
          capabilities: { sendInput: false },
        },
      },
      {
        sessionKey: 'codex-owned:ready',
        runtimeSurface: {
          id: 'codex-owned:ready',
          capabilities: { sendInput: true },
        },
      },
    ], 'codex-owned:ready')).toBe(true);

    expect(ownedRuntimeCanAcceptInput([
      {
        sessionKey: 'codex-owned:active',
        runtimeSurface: {
          id: 'codex-owned:active',
          capabilities: { sendInput: false },
        },
      },
    ], 'codex-owned:active')).toBe(false);
  });

  it('reuses one serialized steer body until the top-level action receipt settles', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        inProgress: true,
        status: 'queued',
      }), { status: 202 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        status: 'completed',
      }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const receipt = fetchOwnedRuntimeSteerReceipt('codex-owned:ready', 'continue');
    await vi.advanceTimersByTimeAsync(750);
    await expect(receipt).resolves.toMatchObject({ response: { status: 200 } });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]).toEqual(fetchMock.mock.calls[1]);
  });
});
