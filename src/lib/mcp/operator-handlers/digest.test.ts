/**
 * Fable Slice 5 — the fetch_raw rate limit (the deliberate hole in the
 * no-raw-tokens wall). The limiter is per MCP-server proc (= per orchestrator
 * session); these pin the sliding window and the handler's deny/allow paths.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  FETCH_RAW_LIMIT,
  FETCH_RAW_WINDOW_MS,
  fetchRawRateCheck,
  handleFetchRaw,
  resetFetchRawLimiter,
} from './digest';
import { handleTranscript } from './status';

vi.mock('./status', () => ({
  handleTranscript: vi.fn(async () => ({
    content: [{ type: 'text', text: '{"summary":"3 transcript events"}' }],
  })),
}));

const T0 = 1_700_000_000_000;

beforeEach(() => {
  resetFetchRawLimiter();
  vi.mocked(handleTranscript).mockClear();
});

describe('fetchRawRateCheck — sliding window', () => {
  it(`allows ${FETCH_RAW_LIMIT} calls, denies the next`, () => {
    for (let i = 0; i < FETCH_RAW_LIMIT; i++) {
      const meter = fetchRawRateCheck(T0 + i);
      expect(meter.allowed).toBe(true);
      expect(meter.used).toBe(i + 1);
    }
    const denied = fetchRawRateCheck(T0 + FETCH_RAW_LIMIT);
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
    expect(denied.retryAfterMs).toBeGreaterThan(0);
  });

  it('the window slides — calls older than the window free up budget', () => {
    // 5 calls spaced 10s apart, so their expiries are distinguishable.
    for (let i = 0; i < FETCH_RAW_LIMIT; i++) fetchRawRateCheck(T0 + i * 10_000);
    expect(fetchRawRateCheck(T0 + 50_000).allowed).toBe(false);
    // Just past the FIRST call's expiry: exactly one slot frees.
    expect(fetchRawRateCheck(T0 + FETCH_RAW_WINDOW_MS + 1).allowed).toBe(true);
    expect(fetchRawRateCheck(T0 + FETCH_RAW_WINDOW_MS + 2).allowed).toBe(false);
    // Past the SECOND call's expiry: the next slot frees.
    expect(fetchRawRateCheck(T0 + FETCH_RAW_WINDOW_MS + 10_001).allowed).toBe(true);
  });

  it('a denied call does not consume budget', () => {
    for (let i = 0; i < FETCH_RAW_LIMIT; i++) fetchRawRateCheck(T0 + i * 10_000);
    fetchRawRateCheck(T0 + 41_000); // denied
    fetchRawRateCheck(T0 + 42_000); // denied
    // At window+1 only the T0 call has expired — exactly ONE slot opens,
    // proving the denied attempts above were never recorded.
    expect(fetchRawRateCheck(T0 + FETCH_RAW_WINDOW_MS + 1).allowed).toBe(true);
    expect(fetchRawRateCheck(T0 + FETCH_RAW_WINDOW_MS + 2).allowed).toBe(false);
  });
});

describe('handleFetchRaw', () => {
  it('delegates to the transcript read with a tail default and appends the meter', async () => {
    const result = await handleFetchRaw({ packetId: 'pkt-1' });
    expect(result.isError).not.toBe(true);
    expect(vi.mocked(handleTranscript)).toHaveBeenCalledWith(
      expect.objectContaining({ packetId: 'pkt-1', tail: true, limit: 50 }),
    );
    const meterLine = result.content.at(-1);
    expect(meterLine && 'text' in meterLine ? meterLine.text : '').toContain(`1/${FETCH_RAW_LIMIT} used`);
  });

  it('denies with guidance once the window is exhausted — no transcript read fires', async () => {
    for (let i = 0; i < FETCH_RAW_LIMIT; i++) fetchRawRateCheck(Date.now());
    const result = await handleFetchRaw({ packetId: 'pkt-1' });
    expect(result.isError).toBe(true);
    const text = 'text' in result.content[0]! ? result.content[0].text : '';
    expect(text).toContain('fetch_raw window exhausted');
    expect(text).toContain('digest');
    expect(vi.mocked(handleTranscript)).not.toHaveBeenCalled();
  });

  it('an explicit cursor read passes through without the tail default', async () => {
    await handleFetchRaw({ packetId: 'pkt-2', cursor: 47 });
    expect(vi.mocked(handleTranscript)).toHaveBeenCalledWith(
      expect.objectContaining({ packetId: 'pkt-2', cursor: 47 }),
    );
    const callArgs = vi.mocked(handleTranscript).mock.calls[0]![0];
    expect(callArgs.tail).toBeUndefined();
  });
});

describe('capFetchRawContent — per-call output byte cap (Slice 6 #1)', () => {
  it('passes small content through untouched', async () => {
    const { capFetchRawContent } = await import('./digest');
    const { content, truncated } = capFetchRawContent([{ type: 'text', text: 'small' }]);
    expect(truncated).toBe(false);
    expect('text' in content[0]! && content[0].text).toBe('small');
  });

  it('truncates oversized content and says so', async () => {
    const { capFetchRawContent, FETCH_RAW_MAX_RESULT_CHARS } = await import('./digest');
    const big = 'x'.repeat(FETCH_RAW_MAX_RESULT_CHARS + 5_000);
    const { content, truncated } = capFetchRawContent([{ type: 'text', text: big }]);
    expect(truncated).toBe(true);
    const text = 'text' in content[0]! ? content[0].text : '';
    expect(text.length).toBeLessThan(big.length);
    expect(text).toContain('fetch_raw output truncated');
  });
});
