import fs from 'node:fs';
import { WebSocket } from 'ws';
import { sleep } from './common.mjs';

export async function inspector(owned) {
  const log = fs.readFileSync(owned.logPath, 'utf8');
  const address = log.match(/Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/[^\s]+)/)?.[1];
  if (!address) throw new Error('Owned process did not expose an inspector');
  const socket = new WebSocket(address);
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  const pending = new Map();
  let id = 0;
  let snapshotFd;
  socket.on('message', raw => {
    const data = JSON.parse(String(raw));
    if (data.method === 'HeapProfiler.addHeapSnapshotChunk' && snapshotFd !== undefined) fs.writeSync(snapshotFd, data.params.chunk);
    const waiter = pending.get(data.id);
    if (waiter) {
      clearTimeout(waiter.timer); pending.delete(data.id);
      if (data.error) waiter.reject(new Error(data.error.message));
      else waiter.resolve(data.result);
    }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const requestId = ++id;
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`Inspector timed out: ${method}`)); }, 180000);
    pending.set(requestId, { resolve, reject, timer });
    socket.send(JSON.stringify({ id: requestId, method, params }));
  });
  return {
    send,
    usage: async () => {
      const value = await send('Runtime.evaluate', { expression: 'JSON.stringify(process.memoryUsage())', returnByValue: true });
      return JSON.parse(value.result.value);
    },
    snapshot: async file => {
      snapshotFd = fs.openSync(file, 'w', 0o600);
      try { await send('HeapProfiler.takeHeapSnapshot', { reportProgress: false }); }
      finally { fs.closeSync(snapshotFd); snapshotFd = undefined; }
    },
    close: () => socket.close(),
  };
}
export async function postGc(client) {
  await client.send('HeapProfiler.collectGarbage');
  await sleep(100);
  return client.usage();
}
// Shallow bytes by constructor/type, not dominator-retained sizes. Preserve the
// raw snapshot privately for a DevTools dominator/retaining-path investigation.
export function summarizeHeap(file) {
  const heap = JSON.parse(fs.readFileSync(file, 'utf8'));
  const fields = heap.snapshot.meta.node_fields;
  const width = fields.length;
  const sizeIndex = fields.indexOf('self_size');
  const nameIndex = fields.indexOf('name');
  const typeIndex = fields.indexOf('type');
  const types = heap.snapshot.meta.node_types[typeIndex];
  const byName = new Map();
  let total = 0;
  for (let i = 0; i < heap.nodes.length; i += width) {
    const size = heap.nodes[i + sizeIndex];
    total += size;
    const type = types[heap.nodes[i + typeIndex]];
    // String contents and path-bearing function names never enter the receipt.
    const constructor = type === 'object' ? heap.strings[heap.nodes[i + nameIndex]] : type;
    const name = /^[A-Za-z_$][\w$ ]{0,60}$/.test(constructor) ? constructor : type;
    const entry = byName.get(name) ?? { name, bytes: 0, count: 0 };
    entry.bytes += size; entry.count++;
    byName.set(name, entry);
  }
  return { totalShallowBytes: total, top: [...byName.values()].sort((a, b) => b.bytes - a.bytes).slice(0, 20) };
}
