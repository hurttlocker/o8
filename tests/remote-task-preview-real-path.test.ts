import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import type { EventStream } from '../scripts/worker/event-stream';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/cortex/spec-ingest', () => ({
  ingestRepoSpecs: vi.fn(async () => ({ scannedFiles: 0, writtenDirectives: 0, deletedStaleDirectives: 0 })),
  purgeOrphanedSpecDirectives: vi.fn(async () => 0),
}));
const dataDir = mkdtempSync(join(tmpdir(), 'o8-remote-preview-'));
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_CLOUD_JOB_LEASE_MS = '15000';
const repoPath = join(dataDir, 'repo');
let servicePort = 0;
const bare = join(dataDir, 'remote.git');
const runtimeRoute = await import('@/app/api/runtime/launch/route');
const pollRoute = await import('@/app/api/cloud/worker-poll/route');
const streamRoute = await import('@/app/api/cloud/worker-stream/route');
const previewRoute = await import('@/app/api/tasks/[taskId]/preview/route');
const relayRoute = await import('@/app/api/cloud/worker-preview/route');
const controlRoute = await import('@/app/api/cloud/worker-control/route');
const { closePreviewServers } = await import('@/lib/cloud/preview-server');
const { updateOperatorDefaults } = await import('@/lib/operator/defaults');
const { startWorkspaceServices } = await import('../scripts/worker/workspace-services');
const { readWorkerPreview } = await import('../scripts/worker/preview');
const { remotePreviewService } = await import('@/lib/cloud/preview-contract');
const { createHash } = await import('node:crypto');
const { addRepo } = await import('@/lib/repos/registry');
const { createCloudWorkerKey, revokeCloudWorkerKey } = await import('@/lib/cloud/worker-auth');
const { getJob, readJobEvents } = await import('@/lib/cloud/job-queue');
const { SqliteCloudJobStore } = await import('@/lib/cloud/sqlite-job-store');
const { closeDb } = await import('@/lib/db');
const { getOrCreateWsToken, WS_TOKEN_PATH } = await import('@/lib/ws-auth');
const { readOrchestratorControlPlaneState, writeOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
const key = createCloudWorkerKey({ teamId: 'team_default', label: 'evidence fixture' });
function git(...args: string[]) { return execFileSync('git', args, { stdio: 'pipe' }).toString().trim(); }
beforeAll(async () => {
  const socket = createServer();
  await new Promise<void>((resolve) => socket.listen(0, '127.0.0.1', resolve));
  servicePort = (socket.address() as AddressInfo).port;
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  mkdirSync(repoPath);
  const manifest = { version: 1, services: [{ name: 'web', command: 'node service.js', port: { preferred: servicePort, env: 'PORT' }, health: { http: `http://127.0.0.1:${servicePort}/health` } }], preview: { url: `http://127.0.0.1:${servicePort}` } };
  writeFileSync(join(repoPath, 'o8.workspace.json'), JSON.stringify(manifest));
  writeFileSync(join(repoPath, 'service.js'), `require('http').createServer((req,res)=>{res.setHeader('content-type','text/html');res.end(req.url==='/health'?'ok':'<h1>Owned remote preview</h1>')}).listen(process.env.PORT,'127.0.0.1')`);
  await updateOperatorDefaults({ workspaceManifestPolicy: 'auto' });
  git('init', '-b', 'main', repoPath);
  git('-C', repoPath, 'config', 'user.name', 'Test');
  git('-C', repoPath, 'config', 'user.email', 'test@example.invalid');
  writeFileSync(join(repoPath, 'README.md'), 'Fixture\n');
  git('-C', repoPath, 'add', '.');
  git('-C', repoPath, 'commit', '-m', 'test: fixture');
  git('init', '--bare', bare);
  git('-C', repoPath, 'remote', 'add', 'origin', bare);
  git('-C', repoPath, 'push', 'origin', 'HEAD:main');
  git('--git-dir', bare, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  git('-C', repoPath, 'remote', 'set-url', 'origin', 'ssh://git@example.invalid/fixture.git');
  const ssh = join(dataDir, 'fixture-ssh');
  writeFileSync(ssh, `#!/bin/sh\nexec git-upload-pack '${bare}'\n`); chmodSync(ssh, 0o755);
  git('-C', repoPath, 'config', 'core.sshCommand', ssh);
  git('-C', repoPath, 'config', 'ssh.variant', 'simple');
  await addRepo(repoPath);
  const state = readOrchestratorControlPlaneState();
  writeOrchestratorControlPlaneState({ ...state, repoPath, runtime: 'codex', packets: [{
    id: 'packet-cloud-preview', referenceLabel: 'packet-cloud-preview', title: 'Remote preview fixture', summary: 'Evidence fixture',
    status: 'draft', queueState: 'queued', releaseState: 'pending', blockedReason: null,
    lane: null, review: null, runtime: 'cloud', workspaceTargetPath: repoPath,
    branchTarget: 'o8/cloud-preview', dependencyPacketIds: [], dependencyLabels: [], attemptCount: 0,
    lastEventAt: new Date().toISOString(), lastEventLabel: 'created', recoveryCount: 0, typecheckAutoRetries: 0,
    orchestratorThreadId: null,
  }] } as Parameters<typeof writeOrchestratorControlPlaneState>[0]);
  const initialized = readOrchestratorControlPlaneState();
  writeOrchestratorControlPlaneState({ ...initialized, packets: [...initialized.packets, { ...initialized.packets[0]!, id: 'packet-cloud-invalid-source' }] });
});
afterAll(() => { closePreviewServers(); vi.restoreAllMocks(); closeDb(); rmSync(dataDir, { recursive: true, force: true }); });
function runtimeLaunch(body: unknown) {
  return runtimeRoute.POST(new NextRequest('http://localhost/api/runtime/launch', {
    method: 'POST', headers: { Authorization: `Bearer ${getOrCreateWsToken()}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }));
}
function workerStream(body: unknown) {
  return streamRoute.POST(new NextRequest('http://localhost/api/cloud/worker-stream', { method: 'POST', headers: { Authorization: `Bearer ${key.plaintext}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
}

async function waitFor<T>(read: () => T | null): Promise<T> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const value = read(); if (value !== null) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Preview fixture timed out.');
}

function openPreview(jobId: string, attempt: number, taskId = 'packet-cloud-preview', token = getOrCreateWsToken()) {
  return previewRoute.POST(new NextRequest(`http://localhost/api/tasks/${taskId}/preview`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', host: 'localhost' }, body: JSON.stringify({ jobId, attempt }),
  }), { params: Promise.resolve({ taskId }) });
}

async function relayBridge() {
  const server = createServer(async (incoming, outgoing) => {
    const parts: Buffer[] = [];
    for await (const part of incoming) parts.push(Buffer.from(part));
    const request = new NextRequest(`http://127.0.0.1${incoming.url ?? '/'}`, {
      method: incoming.method, headers: new Headers(incoming.headers as HeadersInit),
      ...(parts.length ? { body: Buffer.concat(parts) } : {}),
    });
    const pathname = new URL(request.url).pathname;
    const response = pathname === '/api/cloud/worker-poll' ? await pollRoute.GET(request)
      : pathname === '/api/cloud/worker-stream' ? await streamRoute.POST(request)
        : pathname === '/api/cloud/worker-control' ? incoming.method === 'POST' ? await controlRoute.POST(request) : await controlRoute.GET(request)
          : pathname === '/api/cloud/worker-preview' ? incoming.method === 'POST' ? await relayRoute.POST(request) : await relayRoute.GET(request)
            : new Response('Not found', { status: 404 });
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }) };
}

describe('authenticated preview through actual worker and durable task authority', () => {
  it.skipIf(process.platform !== 'linux')('relays only owned current service content, reconnects and rejects stale access', async () => {
    const bin = join(dataDir, 'bin'); mkdirSync(bin);
    const fakeCodex = join(bin, 'codex');
    // Deterministic transport test; model quality is not claimed by this fixture.
    writeFileSync(fakeCodex, '#!/usr/bin/env node\nprocess.stdin.resume();setInterval(()=>{},1000);\n'); chmodSync(fakeCodex, 0o755);
    execFileSync(process.execPath, ['scripts/build-worker.mjs'], { cwd: process.cwd() });
    const bridge = await relayBridge();
    const worker = spawn(process.execPath, [join(process.cwd(), 'dist/worker/o8-worker.mjs'), '--o8-url', bridge.url, '--workspace-dir', join(dataDir, 'worker'), '--worker-id', 'preview-worker', '--control-poll-interval-ms', '1000'], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, O8_CLOUD_WORKER_KEY: key.plaintext, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.file://${bare}/.insteadOf`, GIT_CONFIG_VALUE_0: 'ssh://git@example.invalid/fixture.git' },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let output = ''; worker.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    try {
      const launch = await runtimeLaunch({ runtime: 'cloud', prompt: 'Hold for preview fixture.', cwd: repoPath, repoPath, packetId: 'packet-cloud-preview', branchName: 'o8/cloud-preview', clientMutationId: 'preview-fixture', skipSetup: true });
      expect(launch.status).toBe(200);
      const jobId = ((await launch.json()) as { surfaceId: string }).surfaceId.replace(/^cloud:/, '');
      await waitFor(() => readJobEvents('team_default', jobId).some((event) => event.type === 'service' && (event.payload as { state: string }).state === 'healthy') ? true : null);
      expect(getJob('team_default', jobId)?.launch.remotePreview).toMatchObject({ name: 'web', port: servicePort });
      expect((await openPreview(jobId, 1, 'packet-cloud-preview', '')).status).toBe(403);
      expect((await openPreview(jobId, 1, 'packet-cloud-invalid-source')).status).toBe(409);
      expect((await openPreview(jobId, 0)).status).toBe(400);
      expect((await openPreview(jobId, 2)).status).toBe(409);
      const opened = await openPreview(jobId, 1);
      expect(opened.status).toBe(200);
      const access = await opened.json() as { id: string; url: string };
      expect(new URL(access.url).hostname).toBe('[::1]');
      const handshake = await fetch(access.url, { redirect: 'manual' });
      expect(handshake.status).toBe(303);
      const cookie = handshake.headers.get('set-cookie')!.split(';')[0]!;
      expect(handshake.headers.get('set-cookie')).toContain('HttpOnly; SameSite=Strict');
      const origin = new URL(access.url).origin;
      expect((await fetch(`${origin}/`)).status).toBe(403);
      expect((await fetch(`${origin}/`, { headers: { cookie, origin: 'http://127.0.0.1:9999' } })).status).toBe(403);
      expect((await fetch(`${origin}/`, { method: 'POST', headers: { cookie } })).status).toBe(405);
      const rendered = await fetch(`${origin}/`, { headers: { cookie } });
      expect(rendered.status, output).toBe(200);
      expect(await rendered.text()).toBe('<h1>Owned remote preview</h1>');
      expect(rendered.headers.get('content-security-policy')).toContain("connect-src 'self'");
      expect(rendered.headers.get('set-cookie')).toBeNull();
      closeDb();
      expect(getJob('team_default', jobId)?.claimCount).toBe(1);
      const reconnect = await openPreview(jobId, 1);
      expect(reconnect.status).toBe(200);
      expect((await reconnect.json() as { url: string }).url).not.toBe(access.url);
      const job = getJob('team_default', jobId)!;
      expect((await workerStream({ jobId, workerId: 'preview-worker', leaseToken: job.leaseToken, type: 'service', payload: { name: 'web', state: 'stopped', commandId: job.launch.remotePreview!.commandId, manifestHash: job.launch.remoteManifestHash, claimCount: 1, port: servicePort, health: false } })).status).toBe(200);
      expect((await fetch(`${origin}/`, { headers: { cookie } })).status).toBe(409);
      expect((await openPreview(jobId, 1)).status).toBe(409);
      const oldOperator = getOrCreateWsToken();
      writeFileSync(WS_TOKEN_PATH, 'f'.repeat(64));
      expect((await openPreview(jobId, 1, 'packet-cloud-preview', oldOperator)).status).toBe(403);
      // Reassignment persists a new claim; prior caller/claim access cannot return.
      const store = new SqliteCloudJobStore();
      const future = Date.now() + 30_000;
      store.recoverExpiredLeases('team_default', future);
      const reassigned = store.claimNext({ teamId: 'team_default', cursor: job.cursor, workerId: 'replacement-worker', bootId: 'replacement', leaseMs: 15_000, nowMs: future });
      expect(reassigned?.claimCount).toBe(2);
      closeDb();
      expect(getJob('team_default', jobId)?.claimCount).toBe(2);
      expect((await openPreview(jobId, 1)).status).toBe(409);
      const oldReply = await relayRoute.POST(new Request('http://localhost/api/cloud/worker-preview', {
        method: 'POST', headers: { authorization: `Bearer ${key.plaintext}`, 'content-type': 'application/json' },
        body: JSON.stringify({ jobId, workerId: 'preview-worker', leaseToken: job.leaseToken, attempt: 1, result: { id: 'old', status: 200, body: '', contentType: 'text/html' } }),
      }));
      expect(oldReply.status).toBe(409);
      expect(output).not.toContain(key.plaintext);
    } finally {
      closePreviewServers(); worker.kill('SIGTERM');
      await new Promise<void>((resolve) => { if (worker.exitCode !== null) resolve(); else worker.once('exit', () => resolve()); });
      await bridge.close();
    }
  }, 60_000);

  it.skipIf(process.platform !== 'linux')('rejects a healthy replacement listener even while the task service process lives', async () => {
    const cloneDir = join(dataDir, 'socket-owner'); mkdirSync(cloneDir);
    const source = JSON.stringify({ version: 1, services: [{ name: 'web', command: 'node service.js', port: { preferred: servicePort, env: 'PORT' }, health: { tcp: true } }], preview: { url: `http://127.0.0.1:${servicePort}` } });
    writeFileSync(join(cloneDir, 'o8.workspace.json'), source);
    writeFileSync(join(cloneDir, 'service.js'), "const server=require('http').createServer((q,r)=>r.end('owned')).listen(process.env.PORT,'127.0.0.1');setInterval(()=>{if(require('fs').existsSync('exit-now'))server.close()},20)");
    const service = remotePreviewService(JSON.parse(source))!;
    const job = { id: 'ownership', cursor: 1, claimCount: 1, leaseToken: 'lease', leaseExpiresAt: new Date(Date.now() + 15_000).toISOString(), launch: { prompt: '', remoteManifestHash: createHash('sha256').update(source).digest('hex'), remotePreview: service } };
    const services = await startWorkspaceServices({ cloneDir, job, stream: { postEvent: async () => null } as unknown as InstanceType<typeof EventStream>, signal: new AbortController().signal });
    expect((await readWorkerPreview(job, services!, { id: 'owned', service, path: '/', method: 'GET' }, new AbortController().signal)).status).toBe(200);
    writeFileSync(join(cloneDir, 'exit-now'), 'stop');
    await new Promise((resolve) => setTimeout(resolve, 500));
    const foreign = createServer((_, response) => response.end('foreign private bytes'));
    await new Promise<void>((resolve) => foreign.listen(servicePort, '127.0.0.1', resolve));
    try {
      const denied = await readWorkerPreview(job, services!, { id: 'replacement', service, path: '/', method: 'GET' }, new AbortController().signal);
      expect(denied.status).toBe(503);
      expect(Buffer.from(denied.body, 'base64').toString()).not.toContain('foreign');
    } finally { await services?.stop(); await new Promise<void>((resolve) => foreign.close(() => resolve())); }
  }, 15_000);

  it('rejects revoked worker and wrong lease requests without allocating preview delivery', async () => {
    const active = createCloudWorkerKey({ teamId: 'team_default', label: 'revocation fixture' });
    const url = 'http://localhost/api/cloud/worker-preview?jobId=missing&workerId=forged&leaseToken=old&attempt=1';
    expect((await relayRoute.GET(new Request(url))).status).toBe(401);
    expect((await relayRoute.GET(new Request(url, { headers: { authorization: `Bearer ${active.plaintext}` } }))).status).toBe(409);
    revokeCloudWorkerKey(active.record.id);
    expect((await relayRoute.GET(new Request(url, { headers: { authorization: `Bearer ${active.plaintext}` } }))).status).toBe(403);
    const store = new SqliteCloudJobStore();
    expect(store.get('wrong-team', 'missing')).toBeUndefined();
  });
});
