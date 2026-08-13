import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { StdioJsonRpcPeer } from './stdio-json-rpc';

const roots: string[] = [];

function fixture(source: string): string {
  const root = mkdtempSync(path.join(tmpdir(), 'o8-stdio-json-rpc-'));
  roots.push(root);
  const script = path.join(root, 'fixture.mjs');
  writeFileSync(script, source);
  return script;
}

afterEach(() => {
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
    const peer = new StdioJsonRpcPeer({
      command: process.execPath,
      args: [script],
      cwd: path.dirname(script),
    });
    const notifications: unknown[] = [];
    peer.on('notification', (value) => notifications.push(value));

    await expect(peer.request('first')).resolves.toEqual({ method: 'first', requests: 1 });
    const pid = peer.pid;
    await expect(peer.request('second')).resolves.toEqual({ method: 'second', requests: 2 });
    expect(peer.pid).toBe(pid);
    expect(notifications).toHaveLength(2);
    await peer.close();
    expect(peer.running).toBe(false);
  });

  it('fails closed when stdout contains a non-protocol line', async () => {
    const script = fixture(`
      process.stdin.once('data', () => process.stdout.write('not json\\n'));
      setInterval(() => {}, 1000);
    `);
    const peer = new StdioJsonRpcPeer({
      command: process.execPath,
      args: [script],
      cwd: path.dirname(script),
    }, 1_000);

    await expect(peer.request('initialize')).rejects.toThrow('malformed frame');
    await peer.close({ gracefulMs: 20, terminateMs: 20 });
  });

  it('includes bounded stderr diagnostics on a request timeout', async () => {
    const script = fixture(`
      process.stderr.write('fixture could not initialize\\n');
      process.stdin.resume();
      setInterval(() => {}, 1000);
    `);
    const peer = new StdioJsonRpcPeer({
      command: process.execPath,
      args: [script],
      cwd: path.dirname(script),
    }, 150);

    const stderrReady = new Promise<void>((resolve) => peer.once('stderr', () => resolve()));
    peer.start();
    await stderrReady;
    await expect(peer.request('initialize')).rejects.toThrow('fixture could not initialize');
    await peer.close({ gracefulMs: 20, terminateMs: 20 });
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
    const peer = new StdioJsonRpcPeer({
      command: process.execPath,
      args: [script],
      cwd: path.dirname(script),
    });
    peer.on('request', (request: { id: string | number }) => {
      peer.respond(request.id, { accepted: true });
    });

    await expect(peer.request('initialize')).resolves.toEqual({ accepted: true });
    await peer.close({ gracefulMs: 20, terminateMs: 20 });
  });
});
