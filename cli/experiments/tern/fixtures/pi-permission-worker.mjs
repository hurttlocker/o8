#!/usr/bin/env node
// Scripted Pi RPC peer, not an installed provider. No model, network or work tools.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';

if (process.argv.includes('--version')) {
  process.stdout.write('0.0.0-tern-ownership-fixture\n');
  process.exit(0);
}
const root = process.env.O8_TERN_PI_FIXTURE_ROOT;
if (!root) throw Error('Missing fixture root');
const receipt = join(root, 'worker.jsonl');
const sessionArgument = process.argv.indexOf('--session');
const sessionFile = sessionArgument < 0 ? join(root, 'pi-session.json') : process.argv[sessionArgument + 1];
let turn = 0;
if (sessionArgument >= 0) turn = JSON.parse(readFileSync(sessionFile, 'utf8')).turn;
const record = event => appendFileSync(receipt, `${JSON.stringify({ pid: process.pid, ...event })}\n`);
const send = frame => process.stdout.write(`${JSON.stringify(frame)}\n`);
record({ event: 'boot', argv: process.argv.slice(2), turn });
const input = createInterface({ input: process.stdin });
let pending = null;
input.on('line', line => {
  let frame;
  try { frame = JSON.parse(line); }
  catch { record({ event: 'invalid-input', line }); process.exitCode = 2; input.close(); return; }
  record({ event: 'command', frame });
  if (frame.type === 'prompt' || frame.type === 'follow_up') {
    if (pending) throw Error('Fixture received a second prompt while approval is pending');
    turn += 1;
    pending = `permission-${turn}`;
    send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: `before-permission-${turn}` } });
    send({ type: 'extension_ui_request', id: pending, kind: 'confirm', title: `Fixture permission ${turn}` });
  } else if (frame.type === 'extension_ui_response') {
    if (!pending || frame.id !== pending) throw Error('Uncorrelated permission response');
    const approved = frame.confirmed === true && frame.value === true;
    record({ event: 'permission', requestId: pending, approved });
    pending = null;
    writeFileSync(sessionFile, JSON.stringify({ turn }));
    send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: `${approved ? 'approved' : 'denied'}-${turn}` } });
    send({ type: 'agent_end' });
  } else if (frame.type === 'get_state') {
    send({ type: 'response', command: 'get_state', success: true, id: frame.id,
      data: { sessionId: 'pi-ownership-fixture', sessionFile } });
  } else if (frame.type === 'abort') {
    record({ event: 'abort' });
    input.close();
  } else if (frame.type === 'steer') {
    record({ event: 'steer', message: frame.message });
  } else {
    record({ event: 'unexpected-command', frame });
    process.exitCode = 2;
    input.close();
  }
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  record({ event: 'signal', signal });
  process.exit(0);
});
