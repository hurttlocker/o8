import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Dispatch, SetStateAction } from 'react';
import type { MobileActionResponse, MobileInboxSnapshot } from '@/lib/mobile/types';
import type { ActionState } from './types';
import { runMobileAction } from './controller-actions';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('runMobileAction correlation', () => {
  it('replays one exact mobile action through transport loss and 202 until terminal', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('response lost'))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        action: 'steer',
        sessionKey: 'codex-owned:mobile-worker',
        clientMutationId: 'mobile-action-1',
        status: 'queued',
        inProgress: true,
        note: 'still running',
      }), { status: 202 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        action: 'steer',
        sessionKey: 'codex-owned:mobile-worker',
        clientMutationId: 'mobile-action-1',
        status: 'sent',
        note: 'sent once',
      } satisfies MobileActionResponse), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const actionStates: Array<Record<string, ActionState>> = [];
    const setActionState = ((update: SetStateAction<Record<string, ActionState>>) => {
      const current = actionStates.at(-1) ?? {};
      actionStates.push(typeof update === 'function' ? update(current) : update);
    }) as Dispatch<SetStateAction<Record<string, ActionState>>>;

    const pending = runMobileAction({
      payload: {
        action: 'steer',
        sessionKey: 'codex-owned:mobile-worker',
        clientMutationId: 'mobile-action-1',
        message: 'continue',
      },
      setActionStateBySession: setActionState,
      setActionNoteBySession: vi.fn(),
      realtimeEnabled: true,
      refreshInbox: vi.fn(async () => ({}) as MobileInboxSnapshot),
      loadHistory: vi.fn(async () => undefined),
      loadOwnedReviewPacket: vi.fn(async () => null),
    });
    await vi.advanceTimersByTimeAsync(1_500);

    await expect(pending).resolves.toMatchObject({ status: 'sent', note: 'sent once' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(fetchMock.mock.calls[2]?.[1]?.body);
    expect(actionStates).toEqual([
      { 'codex-owned:mobile-worker': 'steering' },
      { 'codex-owned:mobile-worker': 'idle' },
    ]);
  });
});
