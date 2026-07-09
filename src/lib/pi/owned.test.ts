import { describe, expect, it } from 'vitest';
import {
  buildPiPermissionDefaultResponse,
  splitPiRpcJsonlFrames,
} from './owned';

describe('Pi RPC framing', () => {
  it('splits only on LF and preserves U+2028 inside JSON strings', () => {
    const payload = Buffer.from('{"type":"message_update","text":"a b"}\n{"type":"agent_end"}\n', 'utf8');
    const result = splitPiRpcJsonlFrames(payload);
    expect(result.carry).toBe('');
    expect(result.lines).toHaveLength(2);
    expect(JSON.parse(result.lines[0])).toEqual({
      type: 'message_update',
      text: 'a b',
    });
  });

  it('carries partial frames across chunks', () => {
    const first = splitPiRpcJsonlFrames(Buffer.from('{"type":"agent_', 'utf8'));
    expect(first.lines).toEqual([]);
    const second = splitPiRpcJsonlFrames(Buffer.from('end"}\n', 'utf8'), first.carry);
    expect(second.lines).toEqual(['{"type":"agent_end"}']);
    expect(second.carry).toBe('');
  });
});

describe('Pi permission gate safe defaults', () => {
  it('denies confirm requests', () => {
    expect(buildPiPermissionDefaultResponse({
      type: 'extension_ui_request',
      id: 'req-1',
      kind: 'confirm',
    })).toMatchObject({
      type: 'extension_ui_response',
      id: 'req-1',
      requestId: 'req-1',
      value: false,
      confirmed: false,
    });
  });

  it('cancels select/input requests', () => {
    expect(buildPiPermissionDefaultResponse({
      type: 'extension_ui_request',
      requestId: 'req-2',
      kind: 'select',
    })).toMatchObject({
      type: 'extension_ui_response',
      id: 'req-2',
      requestId: 'req-2',
      cancelled: true,
      value: null,
    });
  });
});
