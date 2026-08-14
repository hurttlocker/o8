/**
 * Assistant-replay dedup regression (2026-06-11).
 *
 * With `--include-partial-messages`, text streams as stream_event-wrapped
 * content_block_delta frames and the final `assistant` message is a replay.
 * The old dedup matched on block INDEX — but the replayed content array
 * compacts when thinking blocks are present (text streamed at index 1
 * replays at position 0), so the replay re-emitted and doubled
 * state.fullResponse. Every non-SSE consumer of the warm REPL pool (MCP
 * cortex_ask, `o8 ask`) returned doubled answers. The fix skips the replay
 * whenever ANY text already streamed this turn.
 */

import { describe, expect, it } from 'vitest';

import { createClaudeCodeStreamJsonParser } from '@/lib/claude-code/stream-json-parser';

function lines(...events: unknown[]): string {
  return events.map((e) => `${JSON.stringify(e)}\n`).join('');
}

const wrap = (event: unknown) => ({ type: 'stream_event', event });

describe('stream-json parser assistant-replay dedup', () => {
  it('skips the replay even when thinking blocks shift the content array', () => {
    const parser = createClaudeCodeStreamJsonParser();
    const events = parser.pushChunk(lines(
      // Thinking is block 0, text streams at block index 1...
      wrap({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hello ' } }),
      wrap({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'world' } }),
      // ...but the replayed assistant message compacts text to position 0.
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Hello world' }] } },
      // REPL result event without a `result` string → done falls back to fullResponse.
      { type: 'result', session_id: 's1' },
    ));

    const deltas = events.filter((e) => e.type === 'delta').map((e) => (e as { text: string }).text);
    expect(deltas.join('')).toBe('Hello world');

    const done = events.find((e) => e.type === 'done') as { text: string } | undefined;
    expect(done?.text).toBe('Hello world');
    expect(parser.getState().fullResponse).toBe('Hello world');
  });

  it('still emits assistant text when nothing streamed (partial messages off)', () => {
    const parser = createClaudeCodeStreamJsonParser();
    const events = parser.pushChunk(lines(
      { type: 'assistant', message: { content: [{ type: 'text', text: 'One blob' }] } },
      { type: 'result', result: 'One blob' },
    ));

    const deltas = events.filter((e) => e.type === 'delta').map((e) => (e as { text: string }).text);
    expect(deltas.join('')).toBe('One blob');

    const done = events.find((e) => e.type === 'done') as { text: string } | undefined;
    expect(done?.text).toBe('One blob');
  });

  it('prefers the result event text when present', () => {
    const parser = createClaudeCodeStreamJsonParser();
    const events = parser.pushChunk(lines(
      wrap({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } }),
      { type: 'result', result: 'final canonical text' },
    ));
    const done = events.find((e) => e.type === 'done') as { text: string } | undefined;
    expect(done?.text).toBe('final canonical text');
  });
});

describe('stream-json parser usage truth', () => {
  it('preserves cache reads and writes on usage and terminal events', () => {
    const parser = createClaudeCodeStreamJsonParser();
    const events = parser.pushChunk(lines({
      type: 'result',
      result: 'done',
      session_id: 'warm-session',
      total_cost_usd: 0.224909,
      usage: {
        input_tokens: 203,
        output_tokens: 11,
        cache_read_input_tokens: 40_448,
        cache_creation_input_tokens: 32,
      },
    }));

    expect(events).toContainEqual({
      type: 'usage',
      inputTokens: 203,
      outputTokens: 11,
      cacheReadTokens: 40_448,
      cacheWriteTokens: 32,
      costUsd: 0.224909,
    });
    expect(events).toContainEqual(expect.objectContaining({
      type: 'done',
      sessionId: 'warm-session',
      cacheReadTokens: 40_448,
      cacheWriteTokens: 32,
    }));
  });
});
