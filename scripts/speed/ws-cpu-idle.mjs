#!/usr/bin/env node
// Standalone WS sampler cost. No installed app, desktop, or real account state.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { distribution, evidencePath, freePort, healthy, launch, root, rss, sleep, stop, writeJson } from './common.mjs';

if (process.platform !== 'darwin') throw new Error('This CPU benchmark requires macOS ps sub-second CPU times');
const output = evidencePath(process.argv.find(arg => arg.startsWith('--output='))?.slice(9)
  ?? `tmp/speed-evidence/ws-cpu-idle-${Date.now()}`);
const durationMs = 600_000;
const warmupMs = 60_000;
const cadenceMs = 5_000;
const settledMs = 300_000;
if (fs.existsSync(output)) throw new Error('Use a fresh evidence directory for each collection');
fs.mkdirSync(output, { recursive: true, mode: 0o700 });
const bundle = path.join(output, 'ws-server-impl.mjs');
const preload = path.join(output, 'isolate.cjs');
fs.writeFileSync(preload, `
const net = require('node:net');
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...args) {
  if (args[1] === '0.0.0.0') args[1] = '127.0.0.1';
  return listen.apply(this, args);
};
require('node:module').syncBuiltinESMExports();
const fetch = global.fetch;
global.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Non-loopback fixture fetch');
  return fetch(input, init);
};
`, { mode: 0o600 });

// Both arms execute this exact bundle. Only the injected constructor option
// differs; keep the production sampler implementation and background work intact.
await build({
  entryPoints: ['src/ws-server.ts'], outfile: bundle, bundle: true, platform: 'node', format: 'esm',
  external: ['node-pty', 'better-sqlite3', 'bindings'],
  alias: { 'server-only': path.join(root, 'scripts/server-only-stub.js') }, logLevel: 'warning',
  banner: { js: `import { createRequire as __o8_createRequire } from 'node:module';
import { fileURLToPath as __o8_fileURLToPath } from 'node:url';
import { dirname as __o8_dirname } from 'node:path';
const require = __o8_createRequire(import.meta.url);
const __filename = __o8_fileURLToPath(import.meta.url); const __dirname = __o8_dirname(__filename);` },
  plugins: [{ name: 'sampler-control', setup(builder) {
    builder.onLoad({ filter: /[/\\]ws-server[/\\]health-watchdog\.ts$/ }, ({ path: file }) => {
      const source = fs.readFileSync(file, 'utf8');
      const assignment = /this\.cpuSampler = [^;]+;/g;
      if ([...source.matchAll(assignment)].length !== 1) throw new Error('Sampler control assignment changed');
      return { contents: source.replace(assignment,
        "this.cpuSampler = process.env.O8_SPEED_WS_CPU_SAMPLER === 'off' ? false : new WsCpuSampler();"), loader: 'ts' };
    });
  } }],
});

function cpuSeconds(value) {
  const [days, clock] = value.includes('-') ? value.split('-') : ['0', value];
  return Number(days) * 86400 + clock.split(':').reduce((total, part) => total * 60 + Number(part), 0);
}
function snapshot(entries) {
  const rows = rss(Object.fromEntries(entries.map(entry => [entry.id, entry.server.child.pid])));
  return Object.fromEntries(entries.map(entry => {
    const own = rows[entry.id].find(row => row.pid === entry.server.child.pid);
    if (!own) throw new Error(`Missing owned server ${entry.id}`);
    return [entry.id, { elapsedMs: performance.now(), cpuSeconds: cpuSeconds(own.cpuTime),
      rssMiB: own.rssMiB, descendants: rows[entry.id].length - 1 }];
  }));
}
if (cpuSeconds('1-01:02:03.45') !== 90123.45 || cpuSeconds('0:00.50') !== 0.5) throw new Error('CPU clock calibration failed');
const receipt = { schema: 'o8/ws-cpu-idle/v1', complete: false,
  createdAt: new Date().toISOString(),
  revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  bundleSha256: createHash('sha256').update(fs.readFileSync(bundle)).digest('hex'),
  node: process.versions.node, platform: process.platform, architecture: process.arch,
  durationMs, warmupMs, cadenceMs, settledMs,
  method: 'Six concurrent standalone compiled WS servers, three per arm; no Next sibling, no clients, no credentials; one identical bundle with cpuSampler:false only in the off arm. CPU is delta process CPU seconds / delta monotonic wall seconds * 100 (one core = 100%). Settled RSS is the median of the final five minutes. No forced GC or external inspector. Concurrent runs share host contention; no competing build/test launched by this harness.',
  runs: [], failures: [],
};
const entries = [];
const save = () => writeJson(path.join(output, 'receipt.json'), receipt);
try {
  for (let run = 1; run <= 3; run++) for (const arm of ['off', 'on']) {
    const id = `${arm}-${run}`;
    const dir = path.join(output, id);
    const data = path.join(dir, 'data');
    const home = path.join(dir, 'home');
    const repo = path.join(dir, 'repo');
    for (const folder of [data, home]) fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    execFileSync('git', ['init', '-q', repo]);
    const apiPort = await freePort();
    let wsPort = await freePort();
    while (wsPort === apiPort) wsPort = await freePort();
    const token = randomBytes(32).toString('hex');
    const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, TMPDIR: dir,
      NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1',
      O8_DATA_DIR: data, CORTEX_IDE_DATA_DIR: data, CORTEX_IDE_DB_PATH: path.join(data, 'db.sqlite'),
      CORTEX_IDE_REPO_ROOT: repo, CORTEX_IDE_REVIEW_REPO_ROOT: repo,
      PORT: String(apiPort), O8_API_PORT: String(apiPort), WS_PORT: String(wsPort), O8_WS_PORT: String(wsPort),
      NEXT_ORIGIN: `http://127.0.0.1:${apiPort}`, WS_TOKEN: token,
      O8_TAURI_MCP_SOCKET: path.join(data, 'native.sock'), O8_DASH_TMUX_SERVER_NAME: `o8-cpu-${process.pid}-${id}`,
      O8_SILENT_EXIT_DETECTOR_ENABLED: '0', O8_SPEED_WS_CPU_SAMPLER: arm,
    };
    const server = launch(['--require', preload, bundle], env, path.join(dir, 'ws.log'), process.execPath, repo);
    const row = { arm, run, samples: [] };
    const entry = { id, server, row, url: `http://127.0.0.1:${wsPort}/health`, token };
    entries.push(entry);
    receipt.runs.push(row);
    await healthy(entry.url, server, token);
  }
  process.stdout.write(`Six owned servers healthy; warming for ${warmupMs / 1000}s.\n`);
  await sleep(warmupMs);
  for (const entry of entries) {
    const health = await (await fetch(entry.url, { signal: AbortSignal.timeout(3000) })).json();
    entry.row.initialHealth = health.eventLoop;
    const expected = entry.row.arm === 'on' ? 'sampling' : 'unavailable';
    if (!health.eventLoop.samples || health.eventLoop.cpuEvidence.status !== expected) {
      throw new Error(`${entry.id} watchdog is not running with sampler ${expected}`);
    }
  }
  let previous = snapshot(entries);
  const baseline = previous;
  const start = performance.now();
  for (let sample = 1; sample <= durationMs / cadenceMs; sample++) {
    await sleep(Math.max(0, start + sample * cadenceMs - performance.now()));
    const current = snapshot(entries);
    for (const entry of entries) {
      const before = previous[entry.id];
      const after = current[entry.id];
      entry.row.samples.push({ elapsedMs: after.elapsedMs - baseline[entry.id].elapsedMs,
        cpuPct: (after.cpuSeconds - before.cpuSeconds) / ((after.elapsedMs - before.elapsedMs) / 1000) * 100,
        rssMiB: after.rssMiB, descendants: after.descendants });
    }
    previous = current;
    save();
    if (sample % 12 === 0) process.stdout.write(`Idle collection ${sample * cadenceMs / 1000}/${durationMs / 1000}s.\n`);
  }
  for (const entry of entries) {
    const row = entry.row;
    row.medianCpuPct = distribution(row.samples.map(sample => sample.cpuPct)).median;
    row.meanCpuPct = (previous[entry.id].cpuSeconds - baseline[entry.id].cpuSeconds)
      / ((previous[entry.id].elapsedMs - baseline[entry.id].elapsedMs) / 1000) * 100;
    row.settledRssMiB = distribution(row.samples.filter(sample => sample.elapsedMs > durationMs - settledMs)
      .map(sample => sample.rssMiB)).median;
    row.finalHealth = (await (await fetch(entry.url, { signal: AbortSignal.timeout(3000) })).json()).eventLoop;
  }
  receipt.summary = Object.fromEntries(['off', 'on'].map(arm => {
    const runs = receipt.runs.filter(run => run.arm === arm);
    return [arm, { medianCpuPct: distribution(runs.map(run => run.medianCpuPct)).median,
      settledRssMiB: distribution(runs.map(run => run.settledRssMiB)).median }];
  }));
  receipt.delta = { medianCpuPct: receipt.summary.on.medianCpuPct - receipt.summary.off.medianCpuPct,
    settledRssMiB: receipt.summary.on.settledRssMiB - receipt.summary.off.settledRssMiB };
  receipt.defaultOnWithinBudget = receipt.delta.medianCpuPct < 0.5 && receipt.delta.settledRssMiB < 5;
  receipt.complete = true;
} catch (error) {
  receipt.failures.push(error.message);
  process.exitCode = 1;
} finally {
  await Promise.all(entries.map(entry => stop(entry.server)));
  save();
}
process.stdout.write(JSON.stringify({ output, complete: receipt.complete,
  runs: receipt.runs.map(({ samples, ...row }) => row), summary: receipt.summary, delta: receipt.delta,
  defaultOnWithinBudget: receipt.defaultOnWithinBudget, failures: receipt.failures }, null, 2) + '\n');
