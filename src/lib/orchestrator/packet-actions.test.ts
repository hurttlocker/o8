import { afterEach, describe, expect, it, vi } from 'vitest';
import { callResetPacket, callRetryPacket } from './packet-actions';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('packet action response messages', () => {
  it('returns the message from a structured reset error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ok: false,
      error: {
        code: 'reset_state_changed',
        message: 'The packet changed while reset was running.',
      },
    }), {
      status: 409,
      headers: { 'Content-Type': 'application/json' },
    })));

    await expect(callResetPacket('packet-structured-error')).resolves.toEqual({
      ok: false,
      note: 'The packet changed while reset was running.',
    });
  });

  it('preserves legacy string errors and successful notes', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Legacy reset error.' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, note: 'Packet retried.' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(callResetPacket('packet-legacy-error')).resolves.toEqual({
      ok: false,
      note: 'Legacy reset error.',
    });
    await expect(callRetryPacket('packet-success')).resolves.toEqual({
      ok: true,
      note: 'Packet retried.',
    });
  });

  it('surfaces a salvaged retry as review-ready from the operator envelope', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      result: {
        reset: false,
        salvaged: true,
        laneId: 'lane-review',
        note: 'Committed work is awaiting review.',
      },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })));

    await expect(callRetryPacket('packet-salvaged')).resolves.toEqual({
      ok: true,
      note: 'Committed work is awaiting review.',
      salvaged: true,
    });
  });

  it('assigns each deliberate reset or retry a distinct mutation key', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      void init;
      return new Response(JSON.stringify({ ok: true, result: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    await callResetPacket('packet-mutation-key');
    await callRetryPacket('packet-mutation-key');

    const bodies = fetchMock.mock.calls.map(([, init]) => (
      JSON.parse(String((init as RequestInit).body)) as { idempotencyKey?: unknown }
    ));
    expect(bodies.map((body) => body.idempotencyKey)).toEqual([
      expect.any(String),
      expect.any(String),
    ]);
    expect(bodies[0].idempotencyKey).not.toBe(bodies[1].idempotencyKey);
  });

  it('polls a live duplicate with the exact same serialized body', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        result: { inProgress: true },
      }), {
        status: 202,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        result: { reset: true, note: 'Packet reset.' },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    vi.stubGlobal('fetch', fetchMock);

    const result = callResetPacket('packet-live-duplicate');
    await vi.runAllTimersAsync();

    await expect(result).resolves.toEqual({ ok: true, note: 'Packet reset.' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstBody = String((fetchMock.mock.calls[0][1] as RequestInit).body);
    const secondBody = String((fetchMock.mock.calls[1][1] as RequestInit).body);
    expect(secondBody).toBe(firstBody);
  });
});
