import { appendFileSync } from 'node:fs';
import readline from 'node:readline';

const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const notify = (method, params) => send({ jsonrpc: '2.0', method, params });
const input = readline.createInterface({ input: process.stdin });
let seq = 0;
let turn = 0;

function event(sessionId, type, data) {
  notify('session.event', {
    sessionId,
    event: { type, seq: seq++, time: Date.now(), data },
  });
}

input.on('line', (line) => {
  const frame = JSON.parse(line);
  if (frame.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: frame.id,
      result: { serverInfo: { name: 'deepseek-harness-sdk-runtime', version: 'fixture-1' } },
    });
    return;
  }
  if (frame.method === 'session/prompt') {
    turn += 1;
    const messageId = `message-${turn}`;
    if (process.env.O8_DEEPSEEK_HARNESS_PID_LOG) {
      appendFileSync(process.env.O8_DEEPSEEK_HARNESS_PID_LOG, `${process.pid}\n`);
    }
    event(frame.params.sessionId, 'agent/inbox/spliced', {
      target: 'next-turn',
      start: 0,
      inserted: [{ id: messageId, role: 'user', content: frame.params.contentBlocks }],
    });
    notify('session.status', { sessionId: frame.params.sessionId, status: 'running' });
    event(frame.params.sessionId, 'assistant/message', {
      turn,
      step: 0,
      message: {
        id: `assistant-${turn}`,
        role: 'assistant',
        content: [{ type: 'text', text: `fixture response ${turn}` }],
        source: { kind: 'model', provider: 'fixture', model: 'deepseek-v4-flash' },
      },
      usage: {
        inputTokens: turn * 10,
        outputTokens: turn * 2,
        cacheReadTokens: turn,
        cacheWriteTokens: 0,
      },
    });
    event(frame.params.sessionId, 'turn/end', { turn, reason: { kind: 'completed' } });
    notify('session.status', { sessionId: frame.params.sessionId, status: 'idle' });
    send({ jsonrpc: '2.0', id: frame.id, result: { messageId } });
    return;
  }
  if (frame.method === 'shutdown') {
    send({ jsonrpc: '2.0', id: frame.id, result: {} });
    setImmediate(() => process.exit(0));
    return;
  }
  send({ jsonrpc: '2.0', id: frame.id, error: { code: -32601, message: 'unknown method' } });
});
