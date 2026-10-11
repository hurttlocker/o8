import { afterEach, describe, expect, it, vi } from 'vitest';
import { CliError } from '../../api';
import type { ResolvedConfig } from '../../config';
import { fetchCorrelatedPacketMutation } from './correlated-mutation';

const cfg: ResolvedConfig = {
  apiPort: 47120,
  apiBase: 'http://127.0.0.1:47120',
  token: null,
  workerPacketId: null,
  source: { port: 'default', token: 'none' },
  dataDir: null,
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('fetchCorrelatedPacketMutation', () => {
  it('accepts a successful queued admission without waiting for background task completion', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true, status: 'queued', note: 'Background turn admitted.',
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const response = await fetchCorrelatedPacketMutation(cfg, '/api/runtime/action', {
      action: 'send_input', clientMutationId: 'queued-admission-key',
    }, { acceptQueuedAdmission: true });
    expect(response.data).toMatchObject({ ok: true, status: 'queued' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps polling explicit pending receipts even when queued admission is allowed', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, status: 'queued' }), { status: 202 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, status: 'queued', inProgress: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, status: 'queued' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const body = { action: 'send_input', clientMutationId: 'queued-pending-key' };
    const pending = fetchCorrelatedPacketMutation(cfg, '/api/runtime/action', body, {
      acceptQueuedAdmission: true, timeoutMs: 1_000, pollMs: 250,
    });
    await vi.advanceTimersByTimeAsync(500);
    await expect(pending).resolves.toMatchObject({ status: 200, data: { status: 'queued' } });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(new Set(fetchMock.mock.calls.map(([, init]) => String((init as RequestInit).body))))
      .toEqual(new Set([JSON.stringify(body)]));
  });

  it('continues waiting for queued packet mutations under the default policy', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, result: { status: 'queued' } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, result: { status: 'completed' } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const pending = fetchCorrelatedPacketMutation(cfg, '/api/orchestrator/reset-packet', {
      packetId: 'queued-default', idempotencyKey: 'queued-default-key',
    }, { timeoutMs: 1_000, pollMs: 250 });
    await vi.advanceTimersByTimeAsync(250);
    await expect(pending).resolves.toMatchObject({ status: 200, data: { result: { status: 'completed' } } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps polling the exact body after an incomplete success receipt', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        result: { status: 'completed' },
      }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const body = { packetId: 'packet-truncated', idempotencyKey: 'same-key' };

    const pending = fetchCorrelatedPacketMutation(cfg, '/api/orchestrator/reset-packet', body, {
      timeoutMs: 1_000,
      pollMs: 250,
    });
    await vi.advanceTimersByTimeAsync(250);
    await expect(pending).resolves.toMatchObject({ status: 200 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(fetchMock.mock.calls[1]?.[0]);
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(fetchMock.mock.calls[1]?.[1]?.body);
  });

  it('fails closed with the exact CLI retry key after its bounded wait', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockImplementation(() => new Response(JSON.stringify({
      ok: true,
      result: {
        inProgress: true,
        status: 'in_progress',
        note: 'The original rerun is still running.',
      },
    }), { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);
    const body = {
      packetId: 'packet-unsettled',
      feedback: 'retry precisely',
      idempotencyKey: 'cli-unsettled-retry-key',
    };

    const pending = fetchCorrelatedPacketMutation(cfg, '/api/orchestrator/rerun-with-feedback', body, {
      timeoutMs: 500,
      pollMs: 250,
    });
    let caught: unknown = null;
    const settled = pending.catch((error) => { caught = error; });
    await vi.advanceTimersByTimeAsync(750);
    await settled;

    expect(caught).toBeInstanceOf(CliError);
    expect(caught).toMatchObject({
      code: 'mutation_receipt_unsettled',
      ambiguous: true,
      hint: expect.stringContaining('--idempotency-key cli-unsettled-retry-key'),
    });
    const requestBodies = fetchMock.mock.calls.map(([, init]) => String((init as RequestInit).body));
    expect(new Set(requestBodies)).toEqual(new Set([JSON.stringify(body)]));
  });
});
