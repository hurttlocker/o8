import { appendFileSync } from 'node:fs';
import readline from 'node:readline';

const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const update = (sessionId, value) => send({
  jsonrpc: '2.0',
  method: 'session/update',
  params: { sessionId, update: value },
});
const input = readline.createInterface({ input: process.stdin });
let turn = 0;
const pendingPrompts = new Map();

function finishPrompt(frame) {
  update(frame.params.sessionId, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'fixture response ' },
  });
  update(frame.params.sessionId, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: String(turn) },
  });
  const prompt = frame.params.prompt?.map((block) => block.text ?? '').join('') ?? '';
  send({
    jsonrpc: '2.0',
    id: frame.id,
    result: prompt.includes('malformed response') ? {} : { stopReason: 'end_turn' },
  });
}

input.on('line', (line) => {
  const frame = JSON.parse(line);
  if (frame.method === undefined && pendingPrompts.has(frame.id)) {
    const prompt = pendingPrompts.get(frame.id);
    pendingPrompts.delete(frame.id);
    if (process.env.O8_DEEPSEEK_HARNESS_PERMISSION_LOG) {
      appendFileSync(
        process.env.O8_DEEPSEEK_HARNESS_PERMISSION_LOG,
        `${frame.result?.outcome?.optionId ?? 'missing'}\n`,
      );
    }
    finishPrompt(prompt);
    return;
  }
  if (frame.method === undefined) {
    if (process.env.O8_DEEPSEEK_HARNESS_PERMISSION_LOG) {
      appendFileSync(process.env.O8_DEEPSEEK_HARNESS_PERMISSION_LOG, 'unexpected-response\n');
    }
    return;
  }
  if (frame.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: frame.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: { promptCapabilities: { image: false, audio: false, embeddedContext: false } },
        agentInfo: { name: 'deepseek-harness-acp', version: 'fixture-1' },
        authMethods: [],
      },
    });
    return;
  }
  if (frame.method === 'session/new') {
    send({
      jsonrpc: '2.0',
      id: frame.id,
      result: { sessionId: 'deepseek-acp-fixture-session', configOptions: [] },
    });
    return;
  }
  if (frame.method === 'session/prompt') {
    turn += 1;
    if (process.env.O8_DEEPSEEK_HARNESS_PID_LOG) {
      appendFileSync(process.env.O8_DEEPSEEK_HARNESS_PID_LOG, `${process.pid}\n`);
    }
    const permissionId = `permission-${turn}`;
    pendingPrompts.set(permissionId, frame);
    send({
      jsonrpc: '2.0',
      id: permissionId,
      method: 'session/request_permission',
      params: {
        sessionId: frame.params.sessionId,
        toolCall: { toolCallId: `tool-${turn}` },
        options: [
          { optionId: 'allow-once', kind: 'allow_once' },
          { optionId: 'reject-once', kind: 'reject_once' },
        ],
      },
    });
    return;
  }
  if (frame.method === 'session/cancel') return;
  send({ jsonrpc: '2.0', id: frame.id, error: { code: -32601, message: 'unknown method' } });
});
