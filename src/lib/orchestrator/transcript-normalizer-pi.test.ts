import { describe, expect, it } from 'vitest';
import { normalizePiBuiltinEvents } from './transcript-normalizer-pi';

const jsonl = (...values: unknown[]) => values.map(value => JSON.stringify(value)).join('\n') + '\n';
const at = '2026-10-15T00:00:00.000Z';

describe('built-in Pi sanitized transcript normalization', () => {
  it('preserves text, tool calls, results and successful settlement in log order', () => {
    expect(normalizePiBuiltinEvents(jsonl(
      { at, type: 'tool_call', name: 'read_file', args: { path: 'README.md' } },
      { at, type: 'tool_result', name: 'read_file', output: 'A useful result', isError: false },
      { at, type: 'assistant', text: 'Read the file.' },
      { at, type: 'settled', outcome: 'finished', summary: 'Finished.' },
    ))).toEqual([
      { seq: 1, ts: at, type: 'tool_call', tool: 'read_file', args: '{"path":"README.md"}', summary: '{"path":"README.md"}' },
      { seq: 2, ts: at, type: 'tool_result', tool: 'read_file', summary: 'A useful result', ok: true },
      { seq: 3, ts: at, type: 'assistant', text: 'Read the file.' },
      { seq: 4, ts: at, type: 'done', exitCode: 0 },
    ]);
  });

  it('rejects malformed shapes, unknown records and incomplete final lines', () => {
    expect(normalizePiBuiltinEvents('broken\n' + jsonl(null, [], 1,
      { type: 'assistant', text: {} }, { type: 'tool_call', name: 'read', args: [] },
      { type: 'tool_result', name: 'read', output: 'ok', isError: 'false' },
      { type: 'settled', outcome: 'running', summary: 'not done' },
      { type: 'settled', outcome: 'finished' },
      { type: 'message', message: { role: 'assistant', content: 'raw session data' } },
    ) + '{"type":"assistant","text":"not yet durable"}')).toEqual([]);
  });

  it.each(['failed', 'interrupted'])('keeps %s visible without inventing a successful done event', outcome => {
    const events = normalizePiBuiltinEvents(jsonl({ type: 'settled', outcome, summary: 'x'.repeat(5_000) }));
    expect(events).toEqual([{ seq: 1, ts: '1970-01-01T00:00:00.000Z', type: 'error',
      message: expect.stringMatching(new RegExp(`^Pi ${outcome}: `)) }]);
    expect(events[0].type === 'error' && events[0].message.length).toBe(240);
  });

  it('bounds every emitted string and uses stable fallback timestamps on repeated reads', () => {
    const raw = jsonl(
      { at: 'not a date', type: 'assistant', text: 'x'.repeat(8_000) },
      { type: 'tool_call', name: 'n'.repeat(400), args: { command: 'x'.repeat(8_000) } },
      { type: 'tool_result', name: 'n'.repeat(400), output: 'x'.repeat(8_000), isError: true },
    );
    const events = normalizePiBuiltinEvents(raw);
    expect(events).toEqual(normalizePiBuiltinEvents(raw));
    expect(events[0]).toMatchObject({ text: expect.any(String), ts: '1970-01-01T00:00:00.000Z' });
    expect(events[0].type === 'assistant' && events[0].text.length).toBe(4_000);
    expect(events[1].type === 'tool_call' && events[1].args.length).toBe(600);
    expect(events[1].type === 'tool_call' && events[1].tool.length).toBe(120);
    expect(events[2]).toMatchObject({ ok: false });
  });

  it('explicitly renumbers a smaller retained window rather than promising durable cursors', () => {
    const first = { at, type: 'assistant', text: 'first' };
    const second = { at, type: 'assistant', text: 'second' };
    expect(normalizePiBuiltinEvents(jsonl(first, second))[1].seq).toBe(2);
    expect(normalizePiBuiltinEvents(jsonl(second))[0].seq).toBe(1);
  });

  it('skips deeply nested arguments that cannot be serialized without losing later records', () => {
    const deepArgs = '{"nested":'.repeat(12_000) + '0' + '}'.repeat(12_000);
    const raw = `{"type":"tool_call","name":"read_file","args":${deepArgs}}\n`
      + jsonl({ at, type: 'assistant', text: 'Still readable.' });
    expect(normalizePiBuiltinEvents(raw)).toEqual([
      { seq: 1, ts: at, type: 'assistant', text: 'Still readable.' },
    ]);
  });
});
