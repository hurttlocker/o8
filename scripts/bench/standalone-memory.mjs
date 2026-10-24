#!/usr/bin/env node
// Run after npm run build (the release's registered webpack standalone build).
// Raw snapshots/logs stay private under work/. Only the path-free receipt is publishable.
// Node 22: node --expose-gc --max-old-space-size=6144 scripts/bench/standalone-memory.mjs
//   --duration-ms=900000 --output=work/standalone-memory-fixed --check
// Default duration is one hour; --check requires at least 15 minutes. Use the
// same Node version and fixture digest for both arms. --server selects a saved
// standalone server.js; keep saved builds in a hidden work/ directory so their
// traced source copies do not enter the checkout's TypeScript source glob.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { buildFixturePlan, materializeFixture } from './interactions/fixtures.mjs';
import { evidencePath, freePort, healthy, launch, root, sleep, stop, writeJson } from '../speed/common.mjs';
import { inspector, postGc, summarizeHeap } from '../speed/memory.mjs';
import { retainingPaths } from '../speed/heap-paths.mjs';
import { retainedOwners } from './standalone-heap.mjs';

const args = Object.fromEntries(process.argv.slice(2).map(value => {
  const [key, ...rest] = value.replace(/^--/, '').split('=');
  return [key, rest.join('=') || true];
}));
const durationMs = Number(args['duration-ms'] ?? 3_600_000);
assert(Number.isSafeInteger(durationMs) && durationMs >= 0, 'Invalid duration');
const output = evidencePath(String(args.output ?? 'work/standalone-memory'));
fs.mkdirSync(output, { recursive: true });
assert(!fs.existsSync(path.join(output, 'server.log')), 'Select a fresh --output directory for each run');
fs.writeFileSync(path.join(output, '.gitignore'), '*\n', { mode: 0o600 });
const serverPath = path.resolve(String(args.server ?? '.next/standalone/server.js'));
assert(fs.existsSync(serverPath), 'Run npm run build before profiling');
const plan = buildFixturePlan(50);
const fixture = materializeFixture(plan, { root: output });
// The shared scale fixture varies default branches, but its template only
// creates main. Give background Git polling the matching local refs as well.
for (const repo of plan.repos) {
  const refs = path.join(fixture.reposRoot, repo.name, '.git', 'refs', 'heads');
  if (repo.defaultBranch !== 'main') {
    fs.writeFileSync(path.join(refs, repo.defaultBranch), fs.readFileSync(path.join(refs, 'main')));
  }
}
const token = randomBytes(32).toString('hex');
fs.writeFileSync(path.join(fixture.dataDir, 'ws-token'), token, { mode: 0o600 });
// Do not inherit account credentials, development hooks, or live service URLs.
const port = await freePort();
const env = {
  PATH: process.env.PATH,
  NODE_ENV: 'production',
  NEXT_TELEMETRY_DISABLED: '1',
  HOSTNAME: '127.0.0.1',
  PORT: String(port),
  O8_API_PORT: String(port),
  O8_WS_PORT: String(await freePort()),
  O8_PACKAGED_APP: '1',
  O8_DATA_DIR: fixture.dataDir,
  CORTEX_IDE_DATA_DIR: fixture.dataDir,
  NODE_COMPILE_CACHE: path.join(fixture.dataDir, 'compile-cache'),
};
for (const name of [
  'CORTEX_IDE_OWNED_CODEX_ROOT', 'CORTEX_IDE_OWNED_CLAUDE_CODE_ROOT',
  'O8_OWNED_GEMINI_ROOT', 'O8_OWNED_OPENCODE_ROOT', 'O8_OWNED_CURSOR_ROOT',
  'O8_OWNED_GROK_ROOT', 'O8_OWNED_PI_ROOT', 'O8_OWNED_PI_BUILTIN_ROOT',
  'O8_OWNED_PRIME_AGENT_ROOT', 'O8_OWNED_DEEPSEEK_HARNESS_ROOT', 'O8_OWNED_HERMES_ROOT',
]) env[name] = path.join(fixture.dataDir, name.toLowerCase());
const launchServer = log => launch(['--inspect=127.0.0.1:0', serverPath], env, path.join(output, log), process.execPath, root);
let owned = launchServer('server.log');
let client;
async function cleanup() {
  client?.close();
  await stop(owned);
  fs.rmSync(fixture.dataDir, { recursive: true, force: true });
}
const interrupt = () => { void cleanup().finally(() => process.exit(130)); };
const terminate = () => { void cleanup().finally(() => process.exit(143)); };
process.once('SIGINT', interrupt);
process.once('SIGTERM', terminate);
const started = performance.now();
const counts = {};
const origin = `http://127.0.0.1:${port}`;
async function read(route, params = {}) {
  const response = await fetch(`${origin}${route}?${new URLSearchParams(params)}`, {
    headers: { Authorization: `Bearer ${token}`, 'x-o8-client-addr': '127.0.0.1' },
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal(response.status, 200, `HTTP failure: ${route} (${response.status})`);
  const body = await response.json();
  assert(!body.error, `API error: ${route}`);
  counts[route] = (counts[route] ?? 0) + 1;
  if (route === '/api/panel/repos') assert.equal(body.repos.length, fixture.repoCount);
  if (route === '/api/panel/files') assert(body.tree.some(file => file.name === 'fixture.txt'));
  if (route === '/api/panel/git/log') assert.equal(body.total, 1);
}
async function cycle(index) {
  const repo = path.join(fixture.reposRoot, fixture.repoNames[index % fixture.repoCount]);
  await read('/api/panel/status');
  await read('/api/panel/repos');
  await read('/api/panel/projects');
  await read('/api/panel/files', { workspace: repo });
  await read('/api/panel/git/log', { repoPath: repo });
  await read('/api/v2/chat-history/list');
}
const mib = bytes => Math.round(bytes / 1024 / 1024 * 100) / 100;
function sample(label, usage) {
  return { label, elapsedSeconds: Math.round((performance.now() - started) / 1000),
    rssMiB: mib(usage.rss), heapUsedMiB: mib(usage.heapUsed),
    heapTotalMiB: mib(usage.heapTotal), externalMiB: mib(usage.external), arrayBuffersMiB: mib(usage.arrayBuffers) };
}
async function capture(label) {
  // Sample before the snapshot: snapshot collection itself expands RSS.
  const memory = sample(label, await postGc(client));
  writeJson(path.join(output, `${label}-memory.json`), memory);
  console.log(JSON.stringify(memory));
  const file = path.join(output, `${label}.heapsnapshot`);
  await client.snapshot(file);
  const modules = await client.send('Runtime.evaluate', {
    expression: `JSON.stringify((() => {
      const paths = Object.keys(process.getBuiltinModule('node:module')._cache);
      return { total: paths.length,
        routeEntries: paths.filter(p => /[\\/]server[\\/]app[\\/].*[\\/](route|page)\\.js$/.test(p)).length,
        previewEntries: paths.filter(p => p.includes('/server/app/preview/')).length,
        clientManifests: paths.filter(p => p.endsWith('_client-reference-manifest.js')).length };
    })())`, returnByValue: true,
  });
  const result = { ...memory, modules: JSON.parse(modules.result.value), heap: summarizeHeap(file),
    owners: retainingPaths(file), retained: retainedOwners(file) };
  globalThis.gc?.();
  return result;
}
async function boot() {
  await healthy(`${origin}/api/panel/status`, owned, token);
  const page = await fetch(`${origin}/dashboard`, { signal: AbortSignal.timeout(60_000) });
  assert.equal(page.status, 200, 'Dashboard render failed');
  await page.arrayBuffer();
  // Allow startup backfills and Next's eager entry loop to finish in both arms.
  await sleep(30_000);
  client = await inspector(owned);
}
try {
  await boot();
  const idle = await capture('idle');
  console.log(JSON.stringify({ phase: 'idle', rssMiB: idle.rssMiB, heapUsedMiB: idle.heapUsedMiB }));
  // A snapshot expands V8's resident pages. Restart before measuring the soak
  // so the baseline cannot hide traffic growth behind snapshot allocation.
  client.close();
  await stop(owned);
  owned = launchServer('traffic-server.log');
  await boot();
  const trafficIdle = sample('traffic-idle', await postGc(client));
  for (let index = 0; index < fixture.repoCount; index++) await cycle(index);
  const warm = sample('warm', await postGc(client));
  const samples = [];
  const deadline = performance.now() + durationMs;
  let index = 0;
  let nextSample = performance.now();
  while (performance.now() < deadline) {
    await cycle(index++);
    if (performance.now() >= nextSample) {
      const row = sample('traffic', await client.usage());
      samples.push(row);
      console.log(JSON.stringify(row));
      nextSample = performance.now() + 30_000;
    }
    await sleep(1000);
  }
  const after = await capture('after');
  const receipt = {
    schema: 'o8/standalone-memory/v1', node: process.version, platform: process.platform,
    build: 'npm run build (registered next build --webpack), .next/standalone/server.js',
    fixture: { repoCount: fixture.repoCount, digest: fixture.digest },
    durationSeconds: durationMs / 1000, counts, idle, trafficIdle, warm, after, samples,
    growthMiB: { rss: Math.round((after.rssMiB - warm.rssMiB) * 100) / 100,
      heap: Math.round((after.heapUsedMiB - warm.heapUsedMiB) * 100) / 100 },
    budgets: { idleRssMiB: 600, retainedHeapGrowthMiB: 10, settledRssGrowthMiB: 20 },
    note: 'Post-GC checkpoints; RSS sampled before snapshots. Idle snapshot uses a separate process so snapshot allocations cannot mask soak growth. Strong-edge dominators and shortest retaining paths are reported separately. Raw snapshots and logs are private.',
  };
  writeJson(path.join(output, 'receipt.json'), receipt);
  console.log(JSON.stringify({ phase: 'after', rssMiB: after.rssMiB, heapUsedMiB: after.heapUsedMiB, growthMiB: receipt.growthMiB }));
  if (args.check) {
    assert(durationMs >= 900_000, 'A checked soak must run for at least 15 minutes');
    assert(idle.rssMiB < 600, 'Idle RSS exceeds 600 MiB');
    assert(trafficIdle.rssMiB < 600, 'Fresh traffic process idle RSS exceeds 600 MiB');
    assert(idle.modules.routeEntries < 20, 'Startup eagerly loaded unused routes');
    assert.equal(idle.modules.previewEntries, 0, 'Startup retained unused preview pages');
    assert(after.rssMiB < 600, 'Settled RSS exceeds 600 MiB');
    assert(receipt.growthMiB.heap <= 10, 'Retained heap grows after warmup');
    assert(receipt.growthMiB.rss <= 20, 'Settled RSS grows after warmup');
    for (const name of ['Request', 'NextRequest', 'Response', 'NextResponse']) {
      assert(after.retained.requestObjects[name] <= idle.retained.requestObjects[name] + 16,
        `Completed traffic retains ${name} objects`);
    }
  }
} finally {
  process.off('SIGINT', interrupt);
  process.off('SIGTERM', terminate);
  await cleanup();
}
