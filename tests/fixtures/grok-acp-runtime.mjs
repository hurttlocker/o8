#!/usr/bin/env node

import { appendFileSync } from 'node:fs';

if (process.argv.includes('--version')) {
  process.stdout.write('grok 1.0.3\n');
  process.exit(0);
}

const sessionId = 'grok-fixture-session';
const pidLog = process.env.O8_GROK_FIXTURE_PID_LOG;
const lifecycleLog = process.env.O8_GROK_FIXTURE_LIFECYCLE_LOG;
if (pidLog) appendFileSync(pidLog, `${process.pid}\n`);

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function record(value) {
  if (lifecycleLog) appendFileSync(lifecycleLog, `${value}\n`);
}

process.stdin.setEncoding('utf8');
let buffer = '';
let turn = 0;

process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.method === 'initialize') {
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: 1,
          agentCapabilities: { sessionCapabilities: { resume: {}, close: {} } },
          agentInfo: { name: 'grok-fixture', version: '1.0.3' },
        },
      });
      continue;
    }
    if (message.method === 'session/new') {
      record(`new:${message.params.cwd}`);
      send({ jsonrpc: '2.0', id: message.id, result: { sessionId } });
      continue;
    }
    if (message.method === 'session/resume') {
      record(`resume:${message.params.sessionId}`);
      send({ jsonrpc: '2.0', id: message.id, result: {} });
      continue;
    }
    if (message.method === 'session/prompt') {
      turn += 1;
      const text = `fixture grok response ${turn}`;
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
        },
      });
      send({
        jsonrpc: '2.0',
        method: '_x.ai/session_notification',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'turn_completed',
            usage: {
              inputTokens: 100 + turn,
              outputTokens: 10 + turn,
              cachedReadTokens: turn,
              costUsdTicks: 10_000_000 * turn,
              modelUsage: { 'grok-4.6': { inputTokens: 100 + turn, outputTokens: 10 + turn } },
            },
          },
        },
      });
      send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } });
      continue;
    }
    if (message.method === 'session/close') {
      record(`close:${message.params.sessionId}`);
      send({ jsonrpc: '2.0', id: message.id, result: {} });
    }
  }
});
