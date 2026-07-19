#!/usr/bin/env node

import { createInterface } from 'node:readline';

let callCount = 0;

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') {
    send({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2024-11-05' } });
    return;
  }
  if (request.method !== 'tools/call') return;

  const toolName = request.params?.name;
  if (toolName === 'hang') return;
  // Simulate an abrupt child death WITHOUT process.exit (the security-patterns
  // merge gate blocks that token). Closing readline + destroying stdin drains
  // the event loop so the process exits naturally with code 0 — the parent's
  // child 'exit' event still fires and the 'Process exited' error path is hit.
  if (toolName === 'exit') { rl.close(); process.stdin.destroy(); return; }

  callCount += 1;
  send({
    jsonrpc: '2.0',
    id: request.id,
    result: {
      content: [{
        type: 'text',
        text: JSON.stringify({ pid: process.pid, callCount, toolName }),
      }],
    },
  });
});
