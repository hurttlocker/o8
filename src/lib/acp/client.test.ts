/**
 * ACP session/update → OrchestratorEvent mapping (Step 3b, pure).
 *
 * Pins the mapping verified against the published spec + live hermes acp v0.17.0:
 * text / thinking / tool_use / tool_result, the stopReason→done/error rule, and
 * graceful ignore of unknown variants (hermes's `usage_update`, plan, command
 * lists, in-flight tool ticks).
 */

import { describe, it, expect } from 'vitest';

import { mapAcpUpdate, mapStopReason } from './client';

describe('mapAcpUpdate', () => {
  it('agent_message_chunk → text', () => {
    expect(mapAcpUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello' } }))
      .toEqual({ type: 'text', text: 'hello' });
  });

  it('agent_thought_chunk → thinking', () => {
    expect(mapAcpUpdate({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'let me think' } }))
      .toEqual({ type: 'thinking', text: 'let me think' });
  });

  it('tool_call → tool_use (title preferred, kind fallback, rawInput as input)', () => {
    expect(mapAcpUpdate({ sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'Read utils.py', kind: 'read', status: 'pending', rawInput: { path: 'utils.py' } }))
      .toEqual({ type: 'tool_use', id: 'c1', name: 'Read utils.py', input: { path: 'utils.py' } });
    expect(mapAcpUpdate({ sessionUpdate: 'tool_call', toolCallId: 'c2', kind: 'execute', status: 'pending' }))
      .toEqual({ type: 'tool_use', id: 'c2', name: 'execute', input: null });
  });

  it('tool_call_update completed → tool_result (ToolCallContent[] flattened)', () => {
    expect(mapAcpUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'def add' } }] }))
      .toEqual({ type: 'tool_result', id: 'c1', name: '', output: 'def add' });
  });

  it('tool_call_update in-progress → null (not surfaced)', () => {
    expect(mapAcpUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'in_progress' })).toBeNull();
  });

  it('unknown / non-event variants → null (graceful)', () => {
    expect(mapAcpUpdate({ sessionUpdate: 'usage_update', size: 256000, used: 27021 })).toBeNull(); // hermes-specific
    expect(mapAcpUpdate({ sessionUpdate: 'available_commands_update', availableCommands: [] })).toBeNull();
    expect(mapAcpUpdate({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'echo' } })).toBeNull();
    expect(mapAcpUpdate({ sessionUpdate: 'plan', entries: [] })).toBeNull();
    expect(mapAcpUpdate({ sessionUpdate: 'current_mode_update', currentModeId: 'default' })).toBeNull();
    expect(mapAcpUpdate(null)).toBeNull();
    expect(mapAcpUpdate('nope')).toBeNull();
    expect(mapAcpUpdate({})).toBeNull();
  });

  it('missing/odd content → empty text, never throws', () => {
    expect(mapAcpUpdate({ sessionUpdate: 'agent_message_chunk' })).toEqual({ type: 'text', text: '' });
    expect(mapAcpUpdate({ sessionUpdate: 'agent_message_chunk', content: 42 })).toEqual({ type: 'text', text: '' });
  });
});

describe('mapStopReason', () => {
  it('refusal → error (the no-provider case)', () => {
    expect(mapStopReason('refusal', 'sess-1').type).toBe('error');
  });
  it('end_turn / other → done with sessionId', () => {
    expect(mapStopReason('end_turn', 'sess-1')).toEqual({ type: 'done', sessionId: 'sess-1', cost: null });
    expect(mapStopReason('max_tokens', 'sess-2')).toEqual({ type: 'done', sessionId: 'sess-2', cost: null });
    expect(mapStopReason('cancelled', null)).toEqual({ type: 'done', sessionId: null, cost: null });
  });
});
