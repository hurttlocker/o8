import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  actionReceiptIsInProgress,
  correlatedActionIsUnsettled,
  fetchCorrelatedActionReceipt,
  type ActionReceiptLike,
} from './action-receipt';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('actionReceiptIsInProgress', () => {
  it('recognizes transport and persisted in-flight receipts', () => {
    expect(actionReceiptIsInProgress(202, null)).toBe(true);
    expect(actionReceiptIsInProgress(200, { inProgress: true })).toBe(true);
    expect(actionReceiptIsInProgress(200, { status: 'in_progress' })).toBe(true);
  });

  it('does not classify a completed replay as in progress', () => {
    expect(actionReceiptIsInProgress(200, { status: 'merged' })).toBe(false);
    expect(actionReceiptIsInProgress(200, { inProgress: false })).toBe(false);
    expect(actionReceiptIsInProgress(202, { inProgress: true, outcomeUnknown: true })).toBe(false);
  });

  it('replays the exact correlated body until the persisted receipt settles', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, result: { inProgress: true } }), { status: 202 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, result: { status: 'merged', merged: true } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const init = { method: 'POST', body: JSON.stringify({ packetId: 'p1', idempotencyKey: 'mutation-1' }) };
    const pending = fetchCorrelatedActionReceipt<{ ok: boolean; result: ActionReceiptLike & { merged?: boolean } }>(
      '/api/orchestrator/merge',
      init,
    );
    await vi.advanceTimersByTimeAsync(750);
    const receipt = await pending;

    expect(receipt.response.status).toBe(200);
    expect(receipt.payload?.result.merged).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]).toEqual(fetchMock.mock.calls[1]);
  });

  it('reuses the same mutation after a response transport failure', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('connection reset'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, result: { inProgress: true } }), { status: 202 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, result: { status: 'merged' } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const init = { method: 'POST', body: JSON.stringify({ packetId: 'p1', idempotencyKey: 'mutation-1' }) };
    const pending = fetchCorrelatedActionReceipt('/api/orchestrator/merge', init);
    await vi.advanceTimersByTimeAsync(1_500);
    expect((await pending).response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0]).toEqual(fetchMock.mock.calls[2]);
  });

  it('fails closed after bounded transport uncertainty', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));
    const pending = fetchCorrelatedActionReceipt('/api/orchestrator/merge', {
      method: 'POST',
      body: JSON.stringify({ idempotencyKey: 'mutation-1' }),
    }, { timeoutMs: 1_500 });
    let caught: unknown = null;
    const settled = pending.catch((error) => { caught = error; });
    await vi.advanceTimersByTimeAsync(1_500);
    await settled;
    expect(correlatedActionIsUnsettled(caught)).toBe(true);
  });

  it('fails closed when the bounded wait ends on a top-level runtime action receipt', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => new Response(JSON.stringify({
      ok: true,
      inProgress: true,
      status: 'queued',
    }), { status: 202 })));
    const pending = fetchCorrelatedActionReceipt('/api/runtime/action', {
      method: 'POST',
      body: JSON.stringify({ clientMutationId: 'runtime-action-1' }),
    }, { timeoutMs: 1_500 });
    let caught: unknown = null;
    const settled = pending.catch((error) => { caught = error; });
    await vi.advanceTimersByTimeAsync(2_250);
    await settled;

    expect(correlatedActionIsUnsettled(caught)).toBe(true);
  });

  it('polls a top-level runtime launch envelope to its exact terminal receipt', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        inProgress: true,
        surfaceId: '',
      }), { status: 202 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        surfaceId: 'codex-owned:settled',
      }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const init = {
      method: 'POST',
      body: JSON.stringify({ clientMutationId: 'runtime-launch-1' }),
    };
    const pending = fetchCorrelatedActionReceipt<{ ok: boolean; inProgress?: boolean; surfaceId?: string }>(
      '/api/runtime/launch',
      init,
    );
    await vi.advanceTimersByTimeAsync(750);

    await expect(pending).resolves.toMatchObject({
      payload: { surfaceId: 'codex-owned:settled' },
    });
    expect(fetchMock.mock.calls[0]).toEqual(fetchMock.mock.calls[1]);
  });

  it('does not treat an empty accepted response as a terminal receipt', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 202 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        status: 'completed',
      }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const pending = fetchCorrelatedActionReceipt('/api/runtime/action', {
      method: 'POST',
      body: JSON.stringify({ clientMutationId: 'runtime-action-empty-202' }),
    });
    await vi.advanceTimersByTimeAsync(750);

    await expect(pending).resolves.toMatchObject({ response: { status: 200 } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
