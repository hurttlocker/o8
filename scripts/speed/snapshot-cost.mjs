#!/usr/bin/env node
// Quantify the profiler's own RSS perturbation on disposable source servers.
import fs from 'node:fs';
import path from 'node:path';
import { root, distribution, round, sleep, writeJson } from './common.mjs';
import { fixture, startStack } from './stack.mjs';
import { rpc } from './mcp.mjs';
import { inspector, postGc } from './memory.mjs';

const parent = path.join(root, `tmp/speed-evidence/snapshot-cost-${Date.now()}`);
fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
const receipt = { schema: 'o8/speed-snapshot-cost/v1', samples: [], failures: [],
  limits: 'Instrument control on warmed MCP/source-server fixture, not an hour-long workload or attribution of all RSS growth.' };
for (let sample = 1; sample <= 3; sample++) {
  const dir = path.join(parent, `sample-${sample}`);
  fs.mkdirSync(dir);
  let stack, client;
  try {
    stack = await startStack(fixture(dir), dir);
    for (let call = 0; call < 3; call++) await rpc(stack, 'tools/list');
    client = await inspector(stack.next);
    const before = await postGc(client);
    await sleep(1000);
    const idle = await postGc(client);
    const file = path.join(dir, 'next.heapsnapshot');
    await client.snapshot(file);
    const after = await postGc(client);
    receipt.samples.push({ sample, before, idle, after, snapshotMiB: round(fs.statSync(file).size / 1024 ** 2),
      idleRssDeltaMiB: round((idle.rss - before.rss) / 1024 ** 2), snapshotRssDeltaMiB: round((after.rss - idle.rss) / 1024 ** 2) });
  } catch (error) { receipt.failures.push(error.message); }
  finally { client?.close(); await stack?.close(); }
}
const deltas = receipt.samples.map(row => row.snapshotRssDeltaMiB);
receipt.snapshotAddedRssMiB = deltas.every(value => value >= 0) ? distribution(deltas) : { samples: deltas, note: 'Signed deltas include RSS decreases; no nonnegative latency distribution applies.' };
writeJson(path.join(root, 'tmp/speed-evidence/snapshot-cost.json'), receipt);
process.stdout.write(JSON.stringify(receipt, null, 2) + '\n');
if (receipt.failures.length || receipt.samples.length !== 3) process.exitCode = 1;
