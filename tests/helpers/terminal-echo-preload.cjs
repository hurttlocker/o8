// Fixture PTY only: keep the production create/attach/input/fan-out path intact.
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');
const net = require('node:net');
const { syncBuiltinESMExports } = require('node:module');
const pty = require('node-pty');
const { WebSocket } = require('ws');
const directory = process.env.O8_ECHO_FIXTURE_DIR;
if (!directory) throw new Error('Missing echo fixture directory');
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...args) {
  if (args[1] === '0.0.0.0') args[1] = '127.0.0.1';
  return listen.apply(this, args);
};
syncBuiltinESMExports();
const originalFetch = global.fetch;
global.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Fixture forbids external fetch');
  return originalFetch(input, init);
};
const starts = new Map();
const receipt = { echoMs: [], delayedMs: [], floodBytes: 0, floodMessages: 0, floodStart: 0, floodEnd: 0 };
const send = WebSocket.prototype.send;
WebSocket.prototype.send = function (value, ...args) {
  if (typeof value === 'string' && value.includes('"channel":"terminal"')) {
    const frame = JSON.parse(value);
    if (frame.event === 'data' && !frame.data.historical) {
      const output = Buffer.from(frame.data.data, 'base64').toString('utf8');
      for (const match of output.matchAll(/@echo:(\d+)@/g)) {
        receipt.echoMs.push(performance.now() - starts.get(match[1]));
      }
      if (output === 'delayed-output') receipt.delayedMs.push(performance.now() - starts.get('delayed'));
      if (output[0] === '~') {
        receipt.floodBytes += output.length;
        receipt.floodMessages += 1;
        receipt.floodEnd = performance.now();
      }
    }
  }
  return send.call(this, value, ...args);
};
pty.spawn = () => {
  let onData = () => {};
  const exits = [];
  let timer;
  return {
    pid: process.pid,
    onData(callback) { onData = callback; },
    onExit(callback) { exits.push(callback); },
    resize() {},
    kill() { clearTimeout(timer); for (const callback of exits.splice(0)) callback({ exitCode: 0 }); },
    write(input) {
      if (input.startsWith('echo:')) {
        const id = input.slice(5);
        starts.set(id, performance.now());
        // Deliberately synchronous: the credit must exist before PTY.write.
        onData(`@echo:${id}@`);
      } else if (input === 'burst') {
        for (let index = 0; index < 4; index += 1) onData(String(index).repeat(256));
      } else if (input === 'queued') {
        onData('Q'.repeat(2048));
      } else if (input === 'delayed') {
        timer = setTimeout(() => {
          starts.set('delayed', performance.now());
          onData('delayed-output');
        }, 60);
      } else if (input === 'flood') {
        receipt.floodBytes = 0; receipt.floodMessages = 0;
        receipt.floodStart = performance.now();
        let remaining = 50 * 1024 * 1024;
        const chunk = '~'.repeat(64 * 1024);
        const emit = () => {
          onData(chunk); remaining -= chunk.length;
          if (remaining) timer = setTimeout(emit, 1);
        };
        emit();
      } else if (input === 'report') {
        writeFileSync(join(directory, 'echo-receipt.json'), JSON.stringify(receipt));
      }
    },
  };
};
