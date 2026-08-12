import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchRuntimeLaunchReceipt,
  fetchRuntimeSteerReceipt,
} from './runtime-mutation-receipt';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('runtime mutation receipts', () => {
  it.each([
    {
      call: () => fetchRuntimeLaunchReceipt({ runtime: 'codex', prompt: 'inspect', repoPath: '/repo' }),
      endpoint: '/api/runtime/launch',
    },
    {
      call: () => fetchRuntimeSteerReceipt('codex-owned:session', 'continue'),
      endpoint: '/api/runtime/action',
    },
  ])('reuses one body for $endpoint through 202 and transport ambiguity', async ({ call, endpoint }) => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        inProgress: true,
        status: 'in_progress',
      }), { status: 202 }))
      .mockRejectedValueOnce(new TypeError('connection reset'))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        status: 'completed',
        surfaceId: endpoint.endsWith('launch') ? 'codex-owned:settled' : undefined,
      }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const receipt = call();
    await vi.advanceTimersByTimeAsync(1_500);
    await expect(receipt).resolves.toMatchObject({ response: { status: 200 } });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const bodies = fetchMock.mock.calls.map(([, init]) => String((init as RequestInit).body));
    expect(new Set(bodies).size).toBe(1);
    expect(JSON.parse(bodies[0])).toMatchObject({ clientMutationId: expect.any(String) });
  });
});
