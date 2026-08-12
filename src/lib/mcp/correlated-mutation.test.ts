import { afterEach, describe, expect, it, vi } from 'vitest';
import { pollCorrelatedMcpMutation } from './correlated-mutation';

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('pollCorrelatedMcpMutation', () => {
  it.each(['clientMutationId', 'idempotencyKey'] as const)(
    'reuses the exact %s body through transport ambiguity and HTTP 202',
    async (correlationField) => {
      vi.useFakeTimers();
      const send = vi.fn()
        .mockRejectedValueOnce(new Error('socket closed after write'))
        .mockResolvedValueOnce(response(200, { result: { completed: true } }))
        .mockResolvedValueOnce(response(202, { ok: true, result: { inProgress: true } }))
        .mockResolvedValueOnce(response(200, { ok: true, result: { completed: true } }));

      const receipt = pollCorrelatedMcpMutation({
        body: { action: 'steer', surfaceId: 'surface-1' },
        correlationField,
        send,
      });
      await vi.runAllTimersAsync();

      await expect(receipt).resolves.toMatchObject({
        ok: true,
        result: { completed: true },
      });
      expect(send).toHaveBeenCalledTimes(4);
      const requestBodies = send.mock.calls.map(([requestBody]) => requestBody as string);
      expect(new Set(requestBodies).size).toBe(1);
      expect(JSON.parse(requestBodies[0])).toMatchObject({
        action: 'steer',
        surfaceId: 'surface-1',
        [correlationField]: expect.any(String),
      });
    },
  );

  it('fails fast on a terminal HTTP error', async () => {
    const send = vi.fn(async () => response(409, {
      ok: false,
      error: { message: 'Correlation id was reused for another body.' },
    }));

    await expect(pollCorrelatedMcpMutation({
      body: { packetId: 'packet-1' },
      correlationField: 'idempotencyKey',
      send,
    })).rejects.toThrow('Correlation id was reused for another body.');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('preserves a caller-supplied correlation id', async () => {
    const send = vi.fn(async (requestBody: string) => {
      void requestBody;
      return response(200, { ok: true, result: { completed: true } });
    });

    await pollCorrelatedMcpMutation({
      body: { packetId: 'packet-1', idempotencyKey: 'caller-key' },
      correlationField: 'idempotencyKey',
      send,
    });

    expect(JSON.parse(send.mock.calls[0][0] as string)).toMatchObject({
      packetId: 'packet-1',
      idempotencyKey: 'caller-key',
    });
  });

  it('keeps polling the exact body after an incomplete success envelope', async () => {
    vi.useFakeTimers();
    const send = vi.fn()
      .mockResolvedValueOnce(response(200, {}))
      .mockResolvedValueOnce(response(200, { ok: true, result: { completed: true } }));

    const receipt = pollCorrelatedMcpMutation({
      body: { packetId: 'packet-incomplete' },
      correlationField: 'clientMutationId',
      send,
    });
    await vi.runAllTimersAsync();

    await expect(receipt).resolves.toMatchObject({ ok: true, result: { completed: true } });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]?.[0]).toBe(send.mock.calls[1]?.[0]);
  });
});
