import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { AcpClient, mapAcpUpdate, mapStopReason } from './client';

const children: AcpClient[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  for (const child of children.splice(0)) child.kill();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('mapAcpUpdate', () => {
  it('maps text and thinking chunks', () => {
    expect(mapAcpUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello' } }))
      .toEqual({ type: 'text', text: 'hello' });
    expect(mapAcpUpdate({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'let me think' } }))
      .toEqual({ type: 'thinking', text: 'let me think' });
  });

  it('maps tool calls and completed results', () => {
    expect(mapAcpUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'c1',
      title: 'Read utils.py',
      kind: 'read',
      status: 'pending',
      rawInput: { path: 'utils.py' },
    })).toEqual({ type: 'tool_use', id: 'c1', name: 'Read utils.py', input: { path: 'utils.py' } });
    expect(mapAcpUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'c1',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'def add' } }],
    })).toEqual({ type: 'tool_result', id: 'c1', name: '', output: 'def add' });
  });

  it('ignores non-terminal and unknown update variants', () => {
    expect(mapAcpUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'in_progress' })).toBeNull();
    expect(mapAcpUpdate({ sessionUpdate: 'usage_update', size: 256_000, used: 27_021 })).toBeNull();
    expect(mapAcpUpdate({ sessionUpdate: 'available_commands_update', availableCommands: [] })).toBeNull();
    expect(mapAcpUpdate({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'echo' } })).toBeNull();
    expect(mapAcpUpdate({ sessionUpdate: 'plan', entries: [] })).toBeNull();
    expect(mapAcpUpdate(null)).toBeNull();
    expect(mapAcpUpdate('nope')).toBeNull();
    expect(mapAcpUpdate({})).toBeNull();
  });

  it('handles missing chunk content without throwing', () => {
    expect(mapAcpUpdate({ sessionUpdate: 'agent_message_chunk' })).toEqual({ type: 'text', text: '' });
    expect(mapAcpUpdate({ sessionUpdate: 'agent_message_chunk', content: 42 })).toEqual({ type: 'text', text: '' });
  });
});

describe('mapStopReason', () => {
  it('maps refusal to an error and other stops to completion', () => {
    expect(mapStopReason('refusal', 'sess-1').type).toBe('error');
    expect(mapStopReason('end_turn', 'sess-1')).toEqual({ type: 'done', sessionId: 'sess-1', cost: null });
    expect(mapStopReason('max_tokens', 'sess-2')).toEqual({ type: 'done', sessionId: 'sess-2', cost: null });
    expect(mapStopReason('cancelled', null)).toEqual({ type: 'done', sessionId: null, cost: null });
  });
});

describe('AcpClient', () => {
  it('boots the ACP process in the requested repository', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'o8-acp-cwd-'));
    tempDirs.push(cwd);
    const peer = String.raw`
      process.stdin.setEncoding('utf8');
      let buffer = '';
      process.stdin.on('data', (chunk) => {
        buffer += chunk;
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          const request = JSON.parse(line);
          const result = request.method === 'initialize'
            ? { protocolVersion: 1 }
            : request.method === 'session/new'
              ? { sessionId: 'session-cwd', configOptions: [{ id: 'model', currentValue: process.cwd() }] }
              : request.method === 'session/set_config_option'
                ? {}
                : null;
          const response = result === null
            ? { jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } }
            : { jsonrpc: '2.0', id: request.id, result };
          process.stdout.write(JSON.stringify(response) + '\n');
        }
      });
    `;
    const client = new AcpClient({ command: process.execPath, args: ['-e', peer], cwd });
    children.push(client);

    await client.initialize();
    const session = await client.newSession(cwd);
    await expect(client.setModel(session.sessionId, 'provider/current-model')).resolves.toBeUndefined();

    expect(session.configOptions[0]?.currentValue).toBe(realpathSync(cwd));
  });
});
