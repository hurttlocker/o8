import { describe, expect, it } from 'vitest';
import { normalizeCodexEvents } from './transcript-normalizer';

const TS = '2026-08-23T13:08:33.642Z';
const COMMAND = '/bin/zsh -lc "sed -n 1,40p src/lib/lane/registry.ts"';

function line(value: Record<string, unknown>): string {
  return JSON.stringify(value);
}

/** The `event_msg` shape: call id lives on the payload. */
function execBegin(ts: string, callId: string, command: string): string {
  return line({ type: 'event_msg', timestamp: ts, payload: { type: 'exec_command_begin', call_id: callId, command } });
}

/** The `item.*` shape: id lives on the item, and the normalizer keys on `id\0command`. */
function itemStarted(ts: string, itemId: string, command: string): string {
  return line({ type: 'item.started', timestamp: ts, item: { type: 'command_execution', id: itemId, command } });
}

function itemCompleted(ts: string, itemId: string, command: string, output: string, exitCode: number): string {
  return line({
    type: 'item.completed',
    timestamp: ts,
    item: { type: 'command_execution', id: itemId, command, aggregated_output: output, exit_code: exitCode },
  });
}

describe('normalizeCodexEvents — one command, one row (#1845)', () => {
  it('collapses the same command announced through several stream shapes', () => {
    // Codex carries one command in both the legacy `event_msg` form and the
    // `item.*` form. Their call ids are derived differently, so an id-keyed
    // dedupe left four identical rows sharing a millisecond timestamp.
    const events = normalizeCodexEvents([
      execBegin(TS, 'call_exec_1', COMMAND),
      itemStarted(TS, 'item_exec_1', COMMAND),
      execBegin(TS, 'call_exec_1', COMMAND),
      itemStarted(TS, 'item_exec_1', COMMAND),
      itemCompleted(TS, 'item_exec_1', COMMAND, 'export function createLane(', 0),
    ].join('\n'));

    const calls = events.filter((event) => event.type === 'tool_call');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ type: 'tool_call', tool: 'exec_command', ts: TS });

    const results = events.filter((event) => event.type === 'tool_result');
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ type: 'tool_result', tool: 'exec_command', ok: true });
  });

  it('keeps a genuine re-run as its own row, because its timestamp differs', () => {
    const later = '2026-08-23T13:09:41.100Z';
    const events = normalizeCodexEvents([
      execBegin(TS, 'call_exec_1', COMMAND),
      itemCompleted(TS, 'item_exec_1', COMMAND, 'first run', 0),
      execBegin(later, 'call_exec_2', COMMAND),
      itemCompleted(later, 'item_exec_2', COMMAND, 'second run', 0),
    ].join('\n'));

    const calls = events.filter((event) => event.type === 'tool_call');
    expect(calls).toHaveLength(2);
    expect(calls.map((call) => call.ts)).toEqual([TS, later]);
  });

  it('does not merge two different commands sharing a timestamp', () => {
    const events = normalizeCodexEvents([
      execBegin(TS, 'call_a', 'git status --short'),
      execBegin(TS, 'call_b', 'npx tsc --noEmit'),
    ].join('\n'));

    expect(events.filter((event) => event.type === 'tool_call')).toHaveLength(2);
  });

  it('returns an empty stream for empty or unparseable input', () => {
    expect(normalizeCodexEvents('')).toEqual([]);
    expect(normalizeCodexEvents('not json\n{oops')).toEqual([]);
  });
});
