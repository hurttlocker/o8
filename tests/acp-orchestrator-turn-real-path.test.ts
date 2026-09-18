/**
 * #2472 — an ACP orchestrator turn is bounded by the turn watchdog and abort,
 * not by the per-request RPC timeout. Drives the real backend `sendTurn`
 * against a fake ACP agent on stdio.
 */
import { describe, expect, it, vi } from 'vitest';

import type { OrchestratorEvent } from '@/lib/lane/orchestrator-stream-events';

vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: vi.fn(async () => undefined) }));
vi.mock('@/lib/mcp/tool-spine/build', () => ({
  buildToolRegistry: () => {
    throw new Error('no o8 MCP in this test');
  },
}));

const { makeAcpBackend } = await import('@/lib/lane/orchestrator-backends/acp');

// Wide enough that a cold node boot answers initialize under suite load.
const REQUEST_TIMEOUT_MS = 2_000;
const PROMPT_DELAY_MS = 3_500;

// mode 'slow': session/prompt streams text, then replies after PROMPT_DELAY_MS.
// mode 'silent': never answers anything (initialize must time out).
// mode 'cancel': session/prompt streams text, replies only on session/cancel.
const peer = String.raw`
  const mode = process.argv[1];
  const delay = Number(process.argv[2]);
  process.stdin.setEncoding('utf8');
  let buffer = '';
  let prompt = null;
  const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
  process.stdin.on('end', () => process.exit(0));
  process.stdin.on('data', (chunk) => {
    if (mode === 'silent') return;
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const m = JSON.parse(line);
      if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: 1 } });
      else if (m.method === 'session/new') send({ jsonrpc: '2.0', id: m.id, result: { sessionId: 'sess-long' } });
      else if (m.method === 'session/prompt') {
        prompt = m;
        send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'sess-long',
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'long turn output' } } } });
        if (mode === 'slow') setTimeout(() => send({ jsonrpc: '2.0', id: m.id, result: { stopReason: 'end_turn' } }), delay);
      } else if (m.method === 'session/cancel' && prompt) {
        send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'sess-long',
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'cancel received' } } } });
        send({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'cancelled' } });
      } else if (m.id !== undefined && m.method) {
        send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not found' } });
      }
    }
  });
`;

function backendFor(mode: 'slow' | 'silent' | 'cancel') {
  return makeAcpBackend({
    id: 'acp',
    label: 'Fake ACP',
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
    resolveLaunch: () => ({ command: process.execPath, args: ['-e', peer, mode, String(PROMPT_DELAY_MS)] }),
  });
}

describe('ACP orchestrator turn timeout (#2472)', () => {
  it('a turn longer than the RPC timeout completes and keeps the agent alive', async () => {
    const backend = backendFor('slow');
    const repo = process.cwd();
    const events: OrchestratorEvent[] = [];
    await backend.sendTurn(repo, 'do the long thing', (e) => events.push(e), { threadId: 'slow' });

    const errors = events.filter((e) => e.type === 'error');
    expect(errors).toEqual([]);
    expect(events).toContainEqual({ type: 'text', text: 'long turn output' });
    expect(events.at(-1)).toEqual({ type: 'done', sessionId: 'sess-long', cost: null });
    const live = backend.peekSession(repo, undefined, 'slow');
    expect(live).toMatchObject({ status: 'ready' });
  }, 15_000);

  it('initialize still times out on the short request default', async () => {
    const backend = backendFor('silent');
    const repo = process.cwd();
    const events: OrchestratorEvent[] = [];
    await backend.sendTurn(repo, 'hello', (e) => events.push(e), { threadId: 'silent' });

    expect(events.at(-1)).toEqual({ type: 'error', error: `ACP initialize timed out after ${REQUEST_TIMEOUT_MS}ms` });
    expect(backend.peekSession(repo, undefined, 'silent')).toBeNull();
  }, 15_000);

  it('abort during a long turn sends session/cancel and ends the turn cancelled', async () => {
    const backend = backendFor('cancel');
    const repo = process.cwd();
    const events: OrchestratorEvent[] = [];
    const controller = new AbortController();
    const turn = backend.sendTurn(repo, 'run until stopped', (e) => {
      events.push(e);
      // Abort only after the RPC timeout has passed, so the turn is genuinely long.
      if (e.type === 'text' && e.text === 'long turn output') setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS + 1_000);
    }, { threadId: 'cancel', signal: controller.signal });
    await turn;

    expect(events.filter((e) => e.type === 'error')).toEqual([]);
    // The fake answers the prompt with stopReason 'cancelled' only after it
    // receives session/cancel; mapStopReason maps that to done.
    expect(events).toContainEqual({ type: 'text', text: 'cancel received' });
    expect(events.at(-1)).toEqual({ type: 'done', sessionId: 'sess-long', cost: null });
    expect(backend.peekSession(repo, undefined, 'cancel')).toMatchObject({ status: 'ready' });
  }, 15_000);
});
