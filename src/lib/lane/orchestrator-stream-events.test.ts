/**
 * Stream-event dedup — the Collide double-render fix. The trailing `assistant`
 * replay must not re-emit text that already streamed via deltas, even when the
 * replay's content array has shifted (thinking blocks) so the block index no
 * longer matches. Content-based dedup, mirroring stream-json-parser.ts.
 */

import { describe, it, expect } from 'vitest';

import { createToolCallTracker, processStreamEvent, type OrchestratorEvent } from './orchestrator-stream-events';

function run(rawEvents: Array<Record<string, unknown>>): OrchestratorEvent[] {
  const out: OrchestratorEvent[] = [];
  const tracker = createToolCallTracker();
  for (const e of rawEvents) {
    processStreamEvent(e, (ev) => out.push(ev), () => {}, () => {}, tracker);
  }
  return out;
}

const textsOf = (events: OrchestratorEvent[]) =>
  events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text);

describe('processStreamEvent — assistant-replay dedup', () => {
  it('does NOT double the answer when the replay block index SHIFTS (the Collide bug)', () => {
    const out = run([
      // Streamed a text delta at index 1 (a thinking block occupied index 0).
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hello world' } },
      // The trailing assistant replay compacted the array — the text is now at position 0.
      // Index-based dedup missed this (hasStreamedText(0) === false) and re-emitted.
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Hello world' }] } },
    ]);
    expect(textsOf(out)).toEqual(['Hello world']); // ONCE, not twice
  });

  it('dedupes even when deltas + replay share the same index (regression guard)', () => {
    const out = run([
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'part' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'part' }] } },
    ]);
    expect(textsOf(out)).toEqual(['part']);
  });

  it('STILL emits the assistant text when nothing streamed (non-SSE turn)', () => {
    const out = run([
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Full answer' }] } },
    ]);
    expect(textsOf(out)).toEqual(['Full answer']);
  });
});
