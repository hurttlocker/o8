#!/usr/bin/env node
// Offline analysis of a private V8 snapshot. No attachment to a live app.
import fs from 'node:fs';
import path from 'node:path';
import { root, writeJson } from './common.mjs';

export function retainingPaths(file, count = 12) {
  const heap = JSON.parse(fs.readFileSync(file, 'utf8'));
  const { node_fields: nf, edge_fields: ef, node_types: nt, edge_types: et } = heap.snapshot.meta;
  const nw = nf.length, ew = ef.length, n = heap.nodes.length / nw;
  const ni = Object.fromEntries(nf.map((name, i) => [name, i]));
  const ei = Object.fromEntries(ef.map((name, i) => [name, i]));
  const offsets = new Uint32Array(n + 1);
  for (let i = 0; i < n; i++) offsets[i + 1] = offsets[i] + heap.nodes[i * nw + ni.edge_count] * ew;
  const targets = [];
  for (let i = 0; i < n; i++) {
    const bytes = heap.nodes[i * nw + ni.self_size];
    if (bytes < 128 * 1024) continue;
    targets.push({ index: i, bytes });
  }
  targets.sort((a, b) => b.bytes - a.bytes);
  targets.length = Math.min(count, targets.length);
  const pending = new Set(targets.map(row => row.index));
  const parent = new Uint32Array(n).fill(0xffffffff);
  const parentEdge = new Uint32Array(n);
  const queue = new Uint32Array(n);
  let head = 0, tail = 1;
  queue[0] = 0; parent[0] = 0;
  while (head < tail && pending.size) {
    const source = queue[head++];
    for (let edge = offsets[source]; edge < offsets[source + 1]; edge += ew) {
      if (et[ei.type][heap.edges[edge + ei.type]] === 'weak') continue;
      const destination = heap.edges[edge + ei.to_node] / nw;
      if (parent[destination] !== 0xffffffff) continue;
      parent[destination] = source; parentEdge[destination] = edge;
      queue[tail++] = destination; pending.delete(destination);
    }
  }
  const safe = value => typeof value === 'string' && /^[A-Za-z_$([\]][\w$ ()/[\].-]{0,70}$/.test(value) && !value.includes('/') ? value : 'key';
  const label = index => {
    const type = nt[ni.type][heap.nodes[index * nw + ni.type]];
    const name = heap.strings[heap.nodes[index * nw + ni.name]];
    return { type, name: ['string', 'concatenated string', 'sliced string'].includes(type) ? type : safe(name) };
  };
  return { method: 'Shortest strong retaining path from snapshot root, not dominator retained size',
    targets: targets.map(target => {
      const steps = [];
      let index = target.index;
      while (index !== 0 && parent[index] !== 0xffffffff && steps.length < 40) {
        const edge = parentEdge[index];
        const type = et[ei.type][heap.edges[edge + ei.type]];
        const name = type === 'element' ? 'element' : safe(heap.strings[heap.edges[edge + ei.name_or_index]]);
        steps.push({ ...label(index), via: name });
        index = parent[index];
      }
      return { bytes: target.bytes, ...label(target.index), path: steps.reverse(), reachable: parent[target.index] !== 0xffffffff };
    }) };
}
if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  const file = fs.realpathSync(process.argv[2]);
  if (!file.startsWith(root + path.sep)) throw new Error('Keep snapshot analysis inside the worktree');
  const receipt = retainingPaths(file);
  writeJson(file + '.paths.json', receipt);
  process.stdout.write(JSON.stringify(receipt, null, 2) + '\n');
}
