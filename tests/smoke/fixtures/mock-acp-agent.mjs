// Minimal mock ACP agent — speaks JSON-RPC 2.0 over NDJSON stdio, enough to
// drive AcpClient through a full turn without a real model/provider. Used by
// tests/smoke/acp-client-smoke.ts.

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (line) handle(JSON.parse(line));
  }
});

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}
function update(sessionId, u) {
  send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: u } });
}

function handle(msg) {
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, agentInfo: { name: 'mock-agent', version: '0.0.1' }, authMethods: [] } });
    return;
  }
  if (msg.method === 'session/new') {
    send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'mock-sess', models: {}, modes: {} } });
    return;
  }
  if (msg.method === 'session/prompt') {
    const sid = msg.params.sessionId;
    // Scripted stream: thinking → tool_call → tool_call_update(completed) → text x2,
    // plus a hermes-style unknown variant that must be ignored.
    update(sid, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'planning' } });
    update(sid, { sessionUpdate: 'usage_update', size: 256000, used: 10 }); // unknown → ignored
    update(sid, { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read file', kind: 'read', status: 'pending', rawInput: { path: 'x.ts' } });
    update(sid, { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'file body' } }] });
    update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done. ' } });
    update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Bye.' } });
    send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
    return;
  }
  if (msg.method === 'session/cancel') {
    // notification — no reply
    return;
  }
}
