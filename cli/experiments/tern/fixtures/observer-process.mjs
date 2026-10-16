// Child-process harness for the actual S2 runLab entry point and public SDK.
// Fake terminal framing follows sdk.test.mjs.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { runLab } from '../demo.mjs';
import * as sdk from '@stencil-hq/tern';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const parsedEvents = file => existsSync(file)
  ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
    .filter(line => line.dir === 'in' && line.verb === 'e' && ['action', 'activate'].includes(line.body?.ev)).length
  : 0;

const APC = '\x1b_tsp;', ST = '\x1b\\';
const hello = { r: 'hello', v: 1, term: 'tern', ver: 'ownership-fixture',
  kinds: ['col', 'text', 'kv', 'table'], features: ['flow'], credits: 1,
  apc: 65536, cols: 100, cell: { w: 8, h: 16 }, dark: true, reduceMotion: false };
const send = message => new Promise((resolve, reject) => {
  if (!process.send) { reject(Error('IPC is required')); return; }
  process.send(message, error => error ? reject(error) : resolve());
});

/** Every node id a frame draws (nodes carry `k`; ids under props are columns and rows, not nodes). */
function nodeIds(frame) {
  const ids = [];
  const walk = node => {
    if (!node || typeof node !== 'object' || typeof node.k !== 'string') return;
    ids.push(node.id);
    for (const child of node.c ?? []) walk(child);
  };
  for (const op of frame.ops ?? []) if (op[0] === 'add') walk(op[4]);
  return ids;
}

class Terminal extends EventEmitter {
  isTTY = true;
  isRaw = false;
  chunks = [];
  injections = 0;
  constructor(mode) {
    super();
    this.output = { isTTY: true, columns: 100, write: bytes => {
      // The SDK writes Uint8Array frames; String() would give comma-separated byte values.
      const text = typeof bytes === 'string' ? bytes : new TextDecoder().decode(bytes);
      this.chunks.push(text);
      if (text.includes(`${APC}q;`)) queueMicrotask(() => {
        if (mode === 'signal') {
          void send({ type: 'waiting-for-hello' });
          return;
        }
        this.emit('data', `${APC}r;${JSON.stringify(hello)}${ST}\x1b[?1;2c`);
      });
      if (text.includes(`${APC}o;`)) {
        const opened = JSON.parse(text.match(/\x1b_tsp;o;([\s\S]*?)\x1b\\/)[1]);
        assert.equal(opened.listen, false);
        assert.equal(typeof opened.id, 'string');
        this.surfaceId = opened.id;
      }
      if (this.injections === 0 && text.includes(`${APC}f;`)) {
        // Inject once the surface is registered and drawn, at every node it drew,
        // so a handler on any node would run. Even then nothing may answer worker RPC.
        const frame = JSON.parse(text.match(/\x1b_tsp;f;([\s\S]*?)\x1b\\/)[1]);
        this.forge(nodeIds(frame));
      }
      if (mode === 'frame-loss' && text.includes(`${APC}f;`)) throw Error('Fixture frame transport loss');
      return true;
    } };
  }
  forge(ids) {
    assert.ok(ids.length > 0, 'no node ids to aim at');
    this.targets = ids;
    for (const id of ids) for (const act of ['approve', 'reject', 'interrupt', 'steer', 'prompt']) {
      this.emit('data', `${APC}e;${JSON.stringify({ ev: 'action', sf: this.surfaceId, id, act })}${ST}`);
      // activate needs an item, or the SDK decodes it as unknown and dispatches nothing.
      this.emit('data', `${APC}e;${JSON.stringify({ ev: 'activate', sf: this.surfaceId, id, item: 'approve' })}${ST}`);
      this.injections += 2;
    }
    this.emit('data', '\x03');
  }
  setRawMode(value) { this.isRaw = value; }
  resume() {}
  pause() {}
}

process.once('message', async ({ mode, payload }) => {
  try {
    const terminal = new Terminal(mode);
    const reads = [];
    // The SDK records each event it parsed; the parent compares that with what was injected.
    const record = join(mkdtempSync(join(tmpdir(), 'tern-observer-')), 'tsp.jsonl');
    const result = await runLab(['--packet', payload.packet.id], {
      input: terminal, output: terminal.output, error: { write() {} },
      env: { TERM_PROGRAM: 'tern', TERN_TSP_RECORD: record },
      timeout: mode === 'signal' ? 30_000 : 1_000,
      loadSdk: async () => sdk,
      // The read envelope comes from the parent's real owned-runtime records.
      // This injection is NOT proof of installed CLI/auth/packet transport.
      execute: async (command, args, options) => {
        assert.equal(command, 'o8');
        assert.deepEqual(args, ['packet', 'info', payload.packet.id, '--json']);
        assert.equal(options.shell, false);
        reads.push({ command, args });
        return { stdout: JSON.stringify(payload), stderr: '' };
      },
    });
    await send({ type: 'done', result, reads, chunks: terminal.chunks,
      injections: terminal.injections, targets: terminal.targets, parsedEvents: parsedEvents(record),
      raw: terminal.isRaw, listeners: terminal.listenerCount('data') });
  } catch (error) {
    await send({ type: 'failure', error: String(error?.stack ?? error) });
    process.exitCode = 1;
  } finally { process.disconnect(); }
});
await send({ type: 'ready' });
