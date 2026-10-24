import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { StdioJsonRpcPeer, type StdioJsonRpcNotification } from './stdio-json-rpc';

const roots: string[] = [];
const peers: StdioJsonRpcPeer[] = [];

function fixture(source: string): string {
  const root = mkdtempSync(path.join(tmpdir(), 'o8-stdio-json-rpc-'));
  roots.push(root);
  const script = path.join(root, 'fixture.mjs');
  // Signal only after the fixture has installed its protocol handlers.
  writeFileSync(script, `${source}\nprocess.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'fixture.ready' }) + '\\n');`);
  return script;
}

async function withReadyPeer(peer: StdioJsonRpcPeer, run: () => Promise<void>, startupMs = 10_000): Promise<void> {
  peers.push(peer);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onReady: (message: StdioJsonRpcNotification) => void = () => {};
  let onFatal: (error: Error) => void = () => {};
  const ready = new Promise<void>((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('Fixture readiness timed out')), startupMs);
    onReady = message => { if (message.method === 'fixture.ready') resolve(); };
    onFatal = reject;
    peer.on('notification', onReady);
    peer.once('fatal', onFatal);
  });
  try {
    try {
      peer.start();
      await ready;
    } finally {
      clearTimeout(timer);
      peer.removeListener('notification', onReady);
      peer.removeListener('fatal', onFatal);
    }
    await run();
  } finally {
    await peer.close({ gracefulMs: 500, terminateMs: 2_000 });
    expect(peer.running, 'fixture must stop before its directory is retired').toBe(false);
  }
}

afterEach(() => {
  const stillRunning = peers.splice(0).some(peer => peer.running);
  if (stillRunning) {
    roots.splice(0); // Preserve the directories if shutdown could not be confirmed.
    throw new Error('Fixture child still running; fixture directories preserved');
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('StdioJsonRpcPeer', () => {
  it('correlates requests and streams notifications on one process', async () => {
    const script = fixture(`
      import readline from 'node:readline';
      const input = readline.createInterface({ input: process.stdin });
      let requests = 0;
      const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
      input.on('line', line => {
        const message = JSON.parse(line);
        requests += 1;
        send({ jsonrpc: '2.0', method: 'progress', params: { requests } });
        send({ jsonrpc: '2.0', id: message.id, result: { method: message.method, requests } });
        if (message.method === 'shutdown') setImmediate(() => process.exit(0));
      });
    `);
    const peer = new StdioJsonRpcPeer({ command: process.execPath, args: [script], cwd: path.dirname(script) });
    await withReadyPeer(peer, async () => {
      const notifications: unknown[] = [];
      peer.on('notification', value => notifications.push(value));
      await expect(peer.request('first')).resolves.toEqual({ method: 'first', requests: 1 });
      const pid = peer.pid;
      await expect(peer.request('second')).resolves.toEqual({ method: 'second', requests: 2 });
      expect(peer.pid).toBe(pid);
      expect(notifications).toHaveLength(2);
    });
  });

  it('fails closed on a non-protocol line after startup exceeds the request deadline', async () => {
    const script = fixture(`
      await new Promise(resolve => setTimeout(resolve, 1_200));
      process.stdin.once('data', () => process.stdout.write('not json\\n'));
      setInterval(() => {}, 1000);
    `);
    const peer = new StdioJsonRpcPeer({ command: process.execPath, args: [script], cwd: path.dirname(script) }, 1_000);
    await withReadyPeer(peer, async () => {
      await expect(peer.request('initialize')).rejects.toThrow('malformed frame');
    });
  });

  it('includes bounded stderr diagnostics on a request timeout', async () => {
    const script = fixture(`
      process.stderr.write('fixture could not initialize\\n');
      process.stdin.resume();
      setInterval(() => {}, 1000);
    `);
    const peer = new StdioJsonRpcPeer({ command: process.execPath, args: [script], cwd: path.dirname(script) }, 150);
    // stdout and stderr are separate pipes; observe stderr explicitly too.
    const stderrReady = new Promise<void>(resolve => peer.once('stderr', () => resolve()));
    await withReadyPeer(peer, async () => {
      await stderrReady;
      await expect(peer.request('initialize')).rejects.toThrow('fixture could not initialize');
    });
  });

  it('answers provider requests that use string ids', async () => {
    const script = fixture(`
      import readline from 'node:readline';
      const input = readline.createInterface({ input: process.stdin });
      const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
      input.once('line', line => {
        const message = JSON.parse(line);
        send({ jsonrpc: '2.0', id: 'provider-request', method: 'confirm', params: { safe: true } });
        input.once('line', response => {
          const confirmation = JSON.parse(response);
          send({ jsonrpc: '2.0', id: message.id, result: confirmation.result });
        });
      });
    `);
    const peer = new StdioJsonRpcPeer({ command: process.execPath, args: [script], cwd: path.dirname(script) });
    peer.on('request', (request: { id: string | number }) => peer.respond(request.id, { accepted: true }));
    await withReadyPeer(peer, async () => {
      await expect(peer.request('initialize')).resolves.toEqual({ accepted: true });
    });
  });

  it('stops the real child when an assertion fails', async () => {
    const script = fixture('process.stdin.resume(); setInterval(() => {}, 1000);');
    const peer = new StdioJsonRpcPeer({ command: process.execPath, args: [script], cwd: path.dirname(script) });
    await expect(withReadyPeer(peer, async () => {
      expect(peer.running).toBe(false); // Deliberate assertion failure exercises finally.
    })).rejects.toThrow('expected true to be false');
    expect(peer.running).toBe(false);
    expect(() => process.kill(peer.pid!, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
  });

  it('bounds readiness and stops a fixture that never becomes ready', async () => {
    const script = fixture('setInterval(() => {}, 1000); await new Promise(() => {});');
    const peer = new StdioJsonRpcPeer({ command: process.execPath, args: [script], cwd: path.dirname(script) });
    let entered = false;
    await expect(withReadyPeer(peer, async () => { entered = true; }, 100))
      .rejects.toThrow('Fixture readiness timed out');
    expect(entered).toBe(false);
    expect(peer.running).toBe(false);
    expect(() => process.kill(peer.pid!, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
  });
});
