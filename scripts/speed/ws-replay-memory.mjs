// Disposable WS replay workload. RSS runs and heap-snapshot runs are separate:
// taking a V8 snapshot changes allocator residency for the rest of the process.
import { build } from 'esbuild';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { retainingPaths } from './heap-paths.mjs';
import { summarizeHeap } from './memory.mjs';

const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const [key, ...value] = arg.replace(/^--/, '').split('=');
  return [key, value.join('=') || true];
}));
const ticks = Number(args.ticks ?? 3600);
const intervalMs = Number(args['interval-ms'] ?? 0);
const settleMs = Number(args['settle-ms'] ?? 45_000);
if (![ticks, intervalMs, settleMs].every(Number.isFinite) || ticks < 1 || intervalMs < 0 || settleMs < 0) {
  throw new Error('Expected positive ticks and nonnegative interval/settle milliseconds');
}
const evidence = resolve(String(args.output ?? 'work/ws-replay-memory'));
mkdirSync(evidence, { recursive: true });
const root = mkdtempSync(join(evidence, 'fixture-'));
const data = join(root, 'data');
const repo = join(root, 'repo');
const profile = join(root, 'profile');
for (const dir of [data, repo, profile]) mkdirSync(dir);
execFileSync('git', ['init', '-q', '-b', 'main', repo]);
const token = randomUUID();
writeFileSync(join(data, 'ws-token'), token, { mode: 0o600 });
const preload = join(root, 'memory.mjs');
writeFileSync(preload, `import {writeHeapSnapshot} from 'node:v8';
process.on('message', request => {
  if (request?.type !== 'memory') return;
  const beforeGc = process.memoryUsage();
  global.gc();
  const afterGc = process.memoryUsage();
  if (request.snapshot) writeHeapSnapshot(request.snapshot);
  process.send({beforeGc, afterGc});
});`);
const api = createServer((request, response) => {
  response.setHeader('Content-Type', 'application/json');
  const result = request.url === '/api/setup/identity' ? { configured: false }
    : request.url === '/api/command-center/snapshot' ? {
      fleet: { agents: [], meta: { mode: 'live' } }, review: null,
      browserInventory: { browsers: [] }, attachedBrowser: null,
    } : { ready: true };
  response.end(JSON.stringify(result));
});
async function freePort() {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let child;
try {
  // Match the existing standalone packager's format, native externals and
  // server-only shim; no build/release configuration is changed by this probe.
  const entry = args.entry ? resolve(String(args.entry)) : join(root, 'ws-server.mjs');
  if (!args.entry) await build({
    entryPoints: ['src/ws-server.ts'], outfile: entry,
    bundle: true, platform: 'node', format: 'esm',
    alias: { 'server-only': resolve('scripts/server-only-stub.js') },
    external: ['node-pty', 'better-sqlite3', 'bindings'],
    banner: { js: [
      'import {createRequire as __o8_require} from "node:module";',
      'import {fileURLToPath as __o8_path} from "node:url";',
      'import {dirname as __o8_dir} from "node:path";',
      `const require=__o8_require(${JSON.stringify(resolve('package.json'))});`,
      'const __filename=__o8_path(import.meta.url);const __dirname=__o8_dir(__filename);',
    ].join('') },
    logLevel: 'silent',
  });
  api.listen(0, '127.0.0.1');
  await once(api, 'listening');
  const apiPort = api.address().port;
  const wsPort = await freePort();
  child = spawn(process.execPath, ['--expose-gc', '--import', preload, entry], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: {
      PATH: process.env.PATH, NODE_ENV: 'test', HOME: profile, USERPROFILE: profile,
      XDG_CONFIG_HOME: join(profile, 'config'), XDG_CACHE_HOME: join(profile, 'cache'),
      O8_DATA_DIR: data, CORTEX_IDE_DATA_DIR: data, CORTEX_IDE_DB_PATH: join(data, 'db.sqlite'),
      CORTEX_IDE_REVIEW_REPO_ROOT: repo, CORTEX_IDE_REPO_ROOT: repo,
      O8_API_PORT: String(apiPort), O8_WS_PORT: String(wsPort),
      NEXT_ORIGIN: `http://127.0.0.1:${apiPort}`,
    },
  });
  let ready = false;
  // Inspect only the readiness marker; runtime output and private paths never
  // enter the public receipt. Drain stderr so a failed child cannot block.
  child.stdout.on('data', (chunk) => { if (String(chunk).includes('WebSocket server listening')) ready = true; });
  child.stderr.on('data', () => {});
  const deadline = Date.now() + 60_000;
  while (!ready && child.exitCode === null && Date.now() < deadline) await sleep(25);
  if (!ready) throw new Error('WS fixture did not reach its listening entry point');
  async function measure(label) {
    const snapshot = args.snapshots ? join(evidence, `${label}.heapsnapshot`) : undefined;
    const reply = once(child, 'message');
    child.send({ type: 'memory', snapshot });
    const [memory] = await reply;
    return { ...memory, ...(snapshot ? { heap: summarizeHeap(snapshot), owners: retainingPaths(snapshot) } : {}) };
  }
  await sleep(settleMs);
  const idle = await measure('idle');
  const started = Date.now();
  const note = 'stream-\u{1F9EA}-'.repeat(16_000);
  for (let tick = 0; tick < ticks; tick += 1) {
    const response = await fetch(`http://127.0.0.1:${wsPort}/internal/realtime`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'mutation', mutation: {
        mutationId: `tick-${tick}`, source: 'server', action: 'recorded-stream', status: 'completed',
        note: note + tick, createdAt: new Date(tick * 1000).toISOString(),
      } }),
    });
    await response.text();
    if (response.status !== 202) throw new Error('WS fixture rejected a stream tick');
    if (intervalMs) await sleep(intervalMs);
  }
  const elapsedMs = Date.now() - started;
  await sleep(settleMs);
  const streamed = await measure('streamed');
  const receipt = {
    node: process.versions.node, entry: 'standalone WS bundle', ticks,
    simulatedSeconds: ticks, elapsedMs, intervalMs, settleMs,
    accelerated: intervalMs < 1000, rssComparable: !args.snapshots,
    idle, streamed,
  };
  writeFileSync(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify(receipt));
  if (args.check && !args.snapshots
    && Math.max(idle.beforeGc.rss, streamed.afterGc.rss) >= 150_000_000) {
    throw new Error('Idle or post-GC loaded RSS exceeded the 150 MB target');
  }
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    await exited;
    clearTimeout(timer);
  }
  api.closeAllConnections();
  await new Promise((resolve) => api.close(resolve));
  rmSync(root, { recursive: true, force: true });
}
