import { execFile, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { afterAll, beforeAll, expect, it } from 'vitest';

const root = mkdtempSync(join(tmpdir(), 'o8-ws-lag-'));
const data = join(root, 'data');
let api: Server;
let child: ChildProcess;
let wsPort: number;
let output = '';
async function port() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const value = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return value;
}
async function health(serverPort = wsPort) {
  const response = await fetch(`http://127.0.0.1:${serverPort}/health`, { signal: AbortSignal.timeout(3000) });
  expect(response.status).toBe(200);
  return await response.json();
}
async function waitFor(check: () => Promise<boolean>, label: string, serverChild = child) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try { if (await check()) return; } catch { /* Listener may still be starting. */ }
    if (serverChild?.exitCode !== null && serverChild?.exitCode !== undefined) throw new Error(`Fixture exited before ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${label}`);
}
async function stopServer(serverChild: ChildProcess) {
  if (serverChild.exitCode !== null || serverChild.signalCode !== null) return;
  const exited = once(serverChild, 'exit');
  serverChild.kill('SIGTERM');
  const stopped = await Promise.race([exited.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 5000))]);
  if (!stopped) { serverChild.kill('SIGKILL'); await exited; }
}
function startServer(serverPort: number, apiPort: number, serverData: string, cpuEvidence?: string) {
  return execFile(process.execPath, ['--require=./tests/helpers/ws-lag-preload.cjs',
    '--import=./scripts/register-server-only-stub.mjs', '--import=tsx', 'src/ws-server.ts'], {
    cwd: process.cwd(), env: { PATH: process.env.PATH, NODE_ENV: 'test', HOME: serverData, USERPROFILE: serverData,
      O8_DATA_DIR: serverData, CORTEX_IDE_DATA_DIR: serverData, CORTEX_IDE_DB_PATH: join(serverData, 'db.sqlite'),
      CORTEX_IDE_REVIEW_REPO_ROOT: root, O8_API_PORT: String(apiPort), O8_WS_PORT: String(serverPort),
      NEXT_ORIGIN: `http://127.0.0.1:${apiPort}`, O8_LAG_FIXTURE_DIR: serverData,
      O8_WS_CPU_EVIDENCE: cpuEvidence, O8_SILENT_EXIT_DETECTOR_ENABLED: '0' },
  });
}
beforeAll(async () => {
  mkdirSync(data);
  const apiPort = await port();
  wsPort = await port();
  api = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(request.url?.startsWith('/api/panel/repos') ? { repos: [] } : {}));
  });
  api.listen(apiPort, '127.0.0.1');
  await once(api, 'listening');
  child = startServer(wsPort, apiPort, data, '1');
  child.stdout?.on('data', (chunk) => { output = (output + String(chunk)).slice(-16000); });
  child.stderr?.on('data', (chunk) => { output = (output + String(chunk)).slice(-16000); });
  await waitFor(async () => Boolean((await health()).eventLoop), 'server health');
}, 40000);
it('captures call sites from the executing implementation bundle outside its working directory', async () => {
  const bundle = join(root, 'ws-server-impl.mjs');
  await build({ stdin: { contents: `
    import { WsCpuSampler } from './src/lib/ws-server/cpu-evidence';
    const sampler = new WsCpuSampler('/unrelated/workspace');
    sampler.start();
    await sampler.capture();
    function bundledFixtureWork() {
      const deadline = performance.now() + 150;
      while (performance.now() < deadline) Math.sqrt(Math.random());
    }
    bundledFixtureWork();
    console.log(JSON.stringify(await sampler.capture()));
    await sampler.stop();
  `, resolveDir: process.cwd(), sourcefile: 'ws-lag-bundle-fixture.ts' }, bundle: true, platform: 'node', format: 'esm', outfile: bundle });
  const { stdout } = await promisify(execFile)(process.execPath, [bundle], { cwd: root, timeout: 10000 });
  const evidence = JSON.parse(stdout);
  expect(evidence).toMatchObject({ status: 'sampled' });
  expect(evidence.frames).toContainEqual(expect.objectContaining({ file: 'ws-server-impl.mjs', functionName: 'bundledFixtureWork' }));
  expect(stdout).not.toContain(root);
});
afterAll(async () => {
  if (child) await stopServer(child);
  if (api?.listening) {
    api.closeAllConnections();
    await new Promise<void>((resolve) => api.close(() => resolve()));
  }
  rmSync(root, { recursive: true, force: true });
});
it('retains sampled blocking call sites through the real server health endpoint', async () => {
  expect((await health()).eventLoop.cpuEvidence?.status).toBe('sampling');
  writeFileSync(join(data, 'block-once'), 'fixture');
  await waitFor(async () => (await health()).eventLoop.cpuEvidence?.status === 'sampled', 'lag CPU evidence');
  const stats = (await health()).eventLoop;
  expect(stats.maxLagMs).toBeGreaterThan(250);
  expect(stats.cpuEvidence.frames).toContainEqual(expect.objectContaining({
    file: 'tests/helpers/ws-lag-preload.cjs', functionName: 'wsLagFixtureBlock',
  }));
  expect(stats.cpuEvidence.frames.length).toBeLessThanOrEqual(8);
  expect(stats.cpuEvidence.sampleCount).toBeGreaterThan(0);
  expect(JSON.stringify(stats.cpuEvidence)).not.toContain(process.cwd());
  await waitFor(async () => (await health()).eventLoop.lastSampleLagMs < 250, 'loop recovery');
  expect((await health()).eventLoop.cpuEvidence).toMatchObject({ status: 'sampled', capturedAt: stats.cpuEvidence.capturedAt });
  expect(output).toContain('cpuEvidence=');
}, 40000);
it('keeps lag detection active without profiling when the evidence opt-in is absent', async () => {
  const serverData = join(root, 'default-data');
  mkdirSync(serverData);
  const serverPort = await port();
  const apiPort = (api.address() as { port: number }).port;
  const serverChild = startServer(serverPort, apiPort, serverData);
  try {
    await waitFor(async () => (await health(serverPort)).eventLoop.samples > 0, 'default watchdog', serverChild);
    expect((await health(serverPort)).eventLoop.cpuEvidence).toEqual({ status: 'unavailable', frames: [] });
    writeFileSync(join(serverData, 'block-once'), 'fixture');
    await waitFor(async () => (await health(serverPort)).eventLoop.maxLagMs > 250, 'default lag counter', serverChild);
    expect((await health(serverPort)).eventLoop.cpuEvidence).toEqual({ status: 'unavailable', frames: [] });
    await waitFor(async () => (await health(serverPort)).eventLoop.lastSampleLagMs < 250, 'default loop recovery', serverChild);
  } finally { await stopServer(serverChild); }
}, 40000);
