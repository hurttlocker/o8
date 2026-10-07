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

if (process.env.O8_HERMES_LAUNCH_LOG) {
  appendFileSync(process.env.O8_HERMES_LAUNCH_LOG, `${JSON.stringify({
    pid: process.pid,
    cwd: process.cwd(),
    home: process.env.HOME ?? null,
    hermesHome: process.env.HERMES_HOME ?? null,
    argv: process.argv.slice(2),
  })}\n`);
}

function finishPrompt(frame) {
  const sessionId = frame.params.sessionId;
  update(sessionId, { sessionUpdate: 'usage_update', size: 256000, used: turn });
  update(sessionId, {
    sessionUpdate: 'tool_call',
    toolCallId: `tool-${turn}`,
    title: 'Read fixture',
    kind: 'read',
    status: 'pending',
    rawInput: { path: 'fixture.txt' },
  });
  update(sessionId, {
    sessionUpdate: 'tool_call_update',
    toolCallId: `tool-${turn}`,
    title: 'Read fixture',
    status: 'completed',
    content: [{ type: 'content', content: { type: 'text', text: 'fixture body' } }],
  });
  update(sessionId, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'hermes fixture response ' },
  });
  update(sessionId, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: String(turn) },
  });
  send({ jsonrpc: '2.0', id: frame.id, result: { stopReason: 'end_turn' } });
}

input.on('line', (line) => {
  const frame = JSON.parse(line);
  if (frame.method === undefined && pendingPrompts.has(frame.id)) {
    const prompt = pendingPrompts.get(frame.id);
    pendingPrompts.delete(frame.id);
    if (process.env.O8_HERMES_PERMISSION_LOG) {
      appendFileSync(
        process.env.O8_HERMES_PERMISSION_LOG,
        `${frame.result?.outcome?.optionId ?? 'missing'}\n`,
      );
    }
    finishPrompt(prompt);
    return;
  }
  if (frame.method === undefined) return;

  if (frame.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: frame.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true },
        agentInfo: { name: 'hermes-agent', version: 'fixture-1' },
        authMethods: [],
      },
    });
    return;
  }

  if (frame.method === 'session/new') {
    send({
      jsonrpc: '2.0',
      id: frame.id,
      result: { sessionId: 'hermes-fixture-session', configOptions: [] },
    });
    return;
  }

  if (frame.method === 'session/resume') {
    send({
      jsonrpc: '2.0',
      id: frame.id,
      result: { configOptions: [] },
    });
    return;
  }

  if (frame.method === 'session/set_model') {
    if (process.env.O8_HERMES_MODEL_LOG) {
      appendFileSync(process.env.O8_HERMES_MODEL_LOG, `${frame.params.modelId}\n`);
    }
    send({ jsonrpc: '2.0', id: frame.id, result: {} });
    return;
  }

  if (frame.method === 'session/prompt') {
    turn += 1;
    if (process.env.O8_HERMES_PID_LOG) {
      appendFileSync(process.env.O8_HERMES_PID_LOG, `${process.pid}\n`);
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
  if (frame.method === 'session/close') {
    send({ jsonrpc: '2.0', id: frame.id, result: {} });
    return;
  }

  send({ jsonrpc: '2.0', id: frame.id, error: { code: -32601, message: 'unknown method' } });
});
