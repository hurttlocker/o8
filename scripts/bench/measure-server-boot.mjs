#!/usr/bin/env node
// Isolated source Next, compiled WS, and tsx WS launches. No desktop or accounts.
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { build } from 'esbuild';
import ts from 'typescript';

if (process.versions.node.split('.')[0] !== '22') throw new Error('Run this benchmark with Node 22.');
const destination = resolve(process.argv.find(arg => arg.startsWith('--out='))?.slice(6) || 'work/server-boot.json');
const count = Number(process.argv.find(arg => arg.startsWith('--launches='))?.slice(11) || 3);
if (!Number.isInteger(count) || count < 1) throw new Error('Launch count must be a positive integer.');
const root = mkdtempSync(join(tmpdir(), 'o8-boot-bench-'));
const rows = [];
const phasePrefix = 'O8_BOOT_PHASE=';

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  await new Promise(done => server.close(done));
  return address.port;
}

function nextTrace() {
  try {
    return readFileSync('.next/dev/trace', 'utf8').trim().split('\n').flatMap(line => JSON.parse(line));
  } catch { return []; }
}

async function compileWs() {
  symlinkSync(resolve('node_modules'), join(root, 'node_modules'), 'junction');
  await build({
    entryPoints: ['src/ws-server.ts'], outfile: join(root, 'ws-server.mjs'), bundle: true,
    platform: 'node', format: 'esm', external: ['node-pty', 'better-sqlite3', 'bindings'],
    alias: { 'server-only': resolve('scripts/server-only-stub.js') }, logLevel: 'silent',
    banner: { js: `import { createRequire as __o8_createRequire } from 'node:module';
import { fileURLToPath as __o8_fileURLToPath } from 'node:url';
import { dirname as __o8_dirname } from 'node:path';
const require = __o8_createRequire(import.meta.url);
const __filename = __o8_fileURLToPath(import.meta.url); const __dirname = __o8_dirname(__filename);` },
    plugins: [{ name: 'observe-boot-phases', setup(builder) {
      builder.onLoad({ filter: /[/\\]src[/\\]ws-server\.ts$/ }, ({ path }) => {
        const source = readFileSync(path, 'utf8');
        const parsed = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
        const boot = parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'bootstrapWsServer');
        const labels = [
          ['httpServer.listen', 'listen'], ['waitForNextReady', 'next-readiness'],
          ['getDb()', 'database'], ['expireStaleApprovals', 'approvals'],
          ['pruneOrphanedCodexWorktreeBranches', 'branch-prune'], ['runWorktreeMaintenanceTick', 'worktree-maintenance'],
          ['sweepMergedPacketVerificationIncidents', 'merged-incidents'], ['await checkLaunchAgentHealth', 'launch-agent-health'],
          ['sweepPacketsMergedByAncestry', 'merged-ancestry'], ['rehydrateOrchestratorSessions', 'session-recovery'],
          ['startStorageAdmissionReconciliation', 'storage-reconciliation'], ['reconcileResourceLeasesAtStartup', 'resource-leases'],
          ['reconcileDependencyImagesAtStartup', 'dependency-images'], ['reconcileStuckLanes', 'workspace-lane-reconciliation'],
          ['startPollingLoops', 'polling'], ['startBrowserDiscoveryRealtimeLoop', 'browser-discovery'],
          ['startAttachedBrowserRefreshLoop', 'attached-browser'], ['scheduleRealtimeRuntimeRefresh', 'runtime-refresh'],
          ['scheduleRealtimeMobileInboxRefresh', 'inbox-refresh'],
        ];
        const insertions = [[boot.body.getStart() + 1, `
let __o8PreviousPhase = 0;
const __o8Phase = (phase: string) => {
  const elapsed = performance.now();
  console.log('${phasePrefix}' + JSON.stringify({ phase, elapsed_ms: Math.round(elapsed), duration_ms: Math.round(elapsed - __o8PreviousPhase) }));
  __o8PreviousPhase = elapsed;
};
__o8Phase('imports-and-top-level');
`]];
        for (const statement of boot.body.statements) {
          const label = labels.find(([needle]) => statement.getText(parsed).includes(needle))?.[1];
          if (label) insertions.push([statement.end, `\n__o8Phase('${label}');\n`]);
        }
        let contents = source;
        for (const [offset, insertion] of insertions.sort((a, b) => b[0] - a[0])) {
          contents = contents.slice(0, offset) + insertion + contents.slice(offset);
        }
        return { contents, loader: 'ts' };
      });
    } }],
  });
}

async function launch(lane, sample) {
  const fixture = join(root, `${lane}-${sample}`);
  const data = join(fixture, 'data');
  const isolated = join(fixture, 'isolated');
  mkdirSync(data, { recursive: true });
  mkdirSync(isolated);
  const repo = join(fixture, 'repo');
  execFileSync('git', ['init', '-q', repo]);
  const apiPort = await freePort();
  const wsPort = await freePort();
  const args = lane === 'next-source'
    ? ['node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '-p', String(apiPort)]
    : lane === 'ws-source'
      ? ['--import=./scripts/register-server-only-stub.mjs', '--import=tsx', 'src/ws-server.ts']
      : [join(root, 'ws-server.mjs')];
  const traceOffset = nextTrace().length;
  const started = performance.now();
  const phases = [];
  let ready = null;
  const child = spawn(process.execPath, args, { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: {
    NODE_ENV: 'development', PATH: process.env.PATH, HOME: isolated, USERPROFILE: isolated,
    O8_DATA_DIR: data, CORTEX_IDE_DATA_DIR: data, CORTEX_IDE_DB_PATH: join(data, 'db.sqlite'),
    CORTEX_IDE_REVIEW_REPO_ROOT: repo, O8_API_PORT: String(apiPort), PORT: String(apiPort),
    O8_WS_PORT: String(wsPort), WS_PORT: String(wsPort), NEXT_ORIGIN: `http://127.0.0.1:${apiPort}`,
    NEXT_TELEMETRY_DISABLED: '1', NODE_OPTIONS: '--max-old-space-size=8192', O8_SILENT_EXIT_DETECTOR_ENABLED: '0',
  } });
  let pending = '';
  const capture = chunk => {
    pending += String(chunk);
    let newline;
    while ((newline = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
      const elapsed = Math.round(performance.now() - started);
      if (line.includes('Ready in') || line.includes('WebSocket server listening')) ready ??= elapsed;
      if (line.startsWith(phasePrefix)) phases.push(JSON.parse(line.slice(phasePrefix.length)));
      if (lane === 'ws-source' && line.includes('crash capture installed')) phases.push({ phase: 'source-imports-through-crash-capture', elapsed_ms: elapsed });
    }
  };
  child.stdout.on('data', capture); child.stderr.on('data', capture);
  let healthy = null;
  try {
    const url = `http://127.0.0.1:${lane === 'next-source' ? apiPort : wsPort}/${lane === 'next-source' ? 'api/panel/status' : 'health'}`;
    while (performance.now() - started < 90_000) {
      if (child.exitCode !== null) throw new Error(`${lane} exited before health.`);
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
        if (response.ok && (await response.json()).product === 'o8') {
          healthy = Math.round(performance.now() - started); break;
        }
      } catch { /* A refused connection is expected before listen. */ }
      await new Promise(done => setTimeout(done, 50));
    }
    if (healthy === null) throw new Error(`${lane} did not become healthy.`);
  } finally {
    const exited = once(child, 'exit');
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already exited */ }
    const force = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already exited */ } }, 5_000);
    if (child.exitCode === null && child.signalCode === null) await exited;
    clearTimeout(force);
    // Reap descendants even if the wrapper exited before them.
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* process group exited */ }
  }
  if (lane === 'next-source') {
    const traces = nextTrace();
    for (const span of traces.slice(traceOffset < traces.length ? traceOffset : 0)) {
      if (['start-dev-server', 'setup-dev-bundler', 'compile-path'].includes(span.name)) {
        const trigger = String(span.tags?.trigger || '');
        const category = ['instrumentation', 'middleware', 'api/panel/status', 'api/review/auto-review']
          .find(name => trigger.includes(name));
        phases.push({ phase: category ? `compile-${category}` : span.name, duration_ms: Math.round(span.duration / 1_000) });
      }
    }
  }
  const row = { lane, launch: sample, ready_ms: ready, healthy_ms: healthy, phases };
  rows.push(row);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, JSON.stringify({ node: process.versions.node, platform: process.platform,
    note: 'Next framework spans overlap; compiled WS mirrors packaged esbuild settings. WS has no Next sibling. Raw application logs and local identities are excluded.', launches: rows }, null, 2) + '\n');
  console.log(JSON.stringify(row));
}

try {
  await compileWs();
  for (const lane of ['next-source', 'ws-compiled', 'ws-source']) {
    for (let sample = 1; sample <= count; sample++) await launch(lane, sample);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
