import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, readdirSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/cortex/spec-ingest', () => ({
  ingestRepoSpecs: vi.fn(async () => ({ scannedFiles: 0, writtenDirectives: 0, deletedStaleDirectives: 0 })),
  purgeOrphanedSpecDirectives: vi.fn(async () => 0),
}));
const dataDir = mkdtempSync(join(tmpdir(), 'o8-review-preview-'));
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
const { addRepo } = await import('@/lib/repos/registry');
const { createCloudWorkerKey, revokeCloudWorkerKey } = await import('@/lib/cloud/worker-auth');
const { getJob, getLatestPacketJob, listJobs, readJobEvents, queueJobControl, enqueueCloudJob, cancelJob } = await import('@/lib/cloud/job-queue');
const { SqliteCloudJobStore } = await import('@/lib/cloud/sqlite-job-store');
const { getSqlite, closeDb } = await import('@/lib/db');
const { getTaskPoolTask } = await import('@/lib/tasks/pool');
const { getOrCreateWsToken } = await import('@/lib/ws-auth');
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
  writeFileSync(join(repoPath, 'service.js'), `require('http').createServer((req,res)=>{res.setHeader('content-type','text/html');if(require('fs').existsSync('unhealthy'))res.statusCode=503;res.end(req.url==='/health'?'ok':'<h1>Owned remote preview</h1>')}).listen(process.env.PORT,'127.0.0.1')`);
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
    id: 'packet-review-preview', referenceLabel: 'packet-review-preview', title: 'Remote preview fixture', summary: 'Evidence fixture',
    status: 'draft', queueState: 'queued', releaseState: 'pending', blockedReason: null,
    lane: null, review: null, runtime: 'cloud', workspaceTargetPath: repoPath,
    branchTarget: 'o8/review-preview', dependencyPacketIds: [], dependencyLabels: [], attemptCount: 0,
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

async function waitFor<T>(read: () => T | null, diagnostics?: () => string): Promise<T> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const value = read(); if (value !== null) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Preview fixture timed out.${diagnostics ? ` ${diagnostics()}` : ''}`);
}

function openPreview(jobId: string, attempt: number, taskId = 'packet-review-preview', token = getOrCreateWsToken()) {
  return previewRoute.POST(new NextRequest(`http://localhost/api/tasks/${taskId}/preview`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', host: 'localhost' }, body: JSON.stringify({ jobId, attempt }),
  }), { params: Promise.resolve({ taskId }) });
}

async function relayBridge() {
  const pollingWorkers = new Set<string>();
  const disconnectedWorkers = new Set<string>();
  const server = createServer(async (incoming, outgoing) => {
    const controller = new AbortController();
    const url = new URL(`http://127.0.0.1${incoming.url ?? '/'}`);
    const workerId = url.searchParams.get('workerId') ?? '';
    const isPoll = url.pathname === '/api/cloud/worker-poll';
    const onAbort = () => controller.abort();
    const onClose = () => {
      if (outgoing.writableEnded) return;
      if (isPoll) disconnectedWorkers.add(workerId);
      controller.abort();
    };
    incoming.once('aborted', onAbort);
    // IncomingMessage.close also fires after a normal request body is read.
    // Only an unfinished response closing means this worker disconnected.
    outgoing.once('close', onClose);
    try {
      const parts: Buffer[] = [];
      for await (const part of incoming) parts.push(Buffer.from(part));
      const request = new NextRequest(url, {
        method: incoming.method, headers: new Headers(incoming.headers as HeadersInit), signal: controller.signal,
        ...(parts.length ? { body: Buffer.concat(parts) } : {}),
      });
      if (isPoll) pollingWorkers.add(workerId);
      const response = isPoll ? await pollRoute.GET(request)
        : url.pathname === '/api/cloud/worker-stream' ? await streamRoute.POST(request)
          : url.pathname === '/api/cloud/worker-control' ? incoming.method === 'POST' ? await controlRoute.POST(request) : await controlRoute.GET(request)
            : url.pathname === '/api/cloud/worker-preview' ? incoming.method === 'POST' ? await relayRoute.POST(request) : await relayRoute.GET(request)
              : new Response('Not found', { status: 404 });
      if (!outgoing.destroyed) {
        outgoing.writeHead(response.status, Object.fromEntries(response.headers));
        outgoing.end(Buffer.from(await response.arrayBuffer()));
      }
    } finally {
      if (isPoll) pollingWorkers.delete(workerId);
      incoming.removeListener('aborted', onAbort);
      outgoing.removeListener('close', onClose);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, pollingWorkers, disconnectedWorkers,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }) };
}

describe('completed remote result preview sessions', () => {
  let parentId = '';
  let childId = '';
  let absoluteDeadline = '';

  it('releases a disconnected HTTP poll before another worker claims the next job', async () => {
    const bridge = await relayBridge();
    const controller = new AbortController();
    const jobId = 'disconnect-recovery-fixture';
    const pending = fetch(`${bridge.url}/api/cloud/worker-poll?workerId=disconnected-worker&waitMs=5000`, {
      headers: { authorization: `Bearer ${key.plaintext}` }, signal: controller.signal,
    });
    try {
      await waitFor(() => bridge.pollingWorkers.has('disconnected-worker') ? true : null);
      controller.abort();
      await expect(pending).rejects.toThrow();
      await waitFor(() => bridge.disconnectedWorkers.has('disconnected-worker') ? true : null);
      enqueueCloudJob('team_default', jobId, { cwd: '', prompt: 'disconnect recovery fixture' });
      const job = getJob('team_default', jobId)!;
      expect(job.status, JSON.stringify({ status: job.status, claimedBy: job.claimedBy })).toBe('pending');
      const claim = await fetch(`${bridge.url}/api/cloud/worker-poll?workerId=following-worker&waitMs=0`, {
        headers: { authorization: `Bearer ${key.plaintext}` },
      });
      expect(claim.status).toBe(200);
      expect((await claim.json()).job.id).toBe(jobId);
      expect(getJob('team_default', jobId)!.claimedBy).toBe('following-worker');
    } finally { controller.abort(); cancelJob('team_default', jobId); await bridge.close(); }
  });

  it('enqueues one separately bound preview without replacing the completed task', async () => {
    await pollRoute.GET(new Request('http://localhost/api/cloud/worker-poll?workerId=review-worker&waitMs=0', {
      headers: { authorization: `Bearer ${key.plaintext}` },
    }));
    const launch = await runtimeLaunch({ runtime: 'cloud', prompt: 'Completed result fixture.', cwd: repoPath,
      repoPath, packetId: 'packet-review-preview', branchName: 'o8/review-preview', clientMutationId: 'review-fixture',
      model: 'gpt-6.1-sol', effort: 'medium', skipSetup: true });
    expect(launch.status).toBe(200);
    parentId = (await launch.json()).surfaceId.replace(/^cloud:/, '');
    const claimed = await pollRoute.GET(new Request('http://localhost/api/cloud/worker-poll?workerId=review-worker&waitMs=0', {
      headers: { authorization: `Bearer ${key.plaintext}` },
    }));
    const parent = (await claimed.json()).job;
    expect(parent.id).toBe(parentId);
    const sha = git('-C', repoPath, 'rev-parse', 'HEAD');
    git('--git-dir', bare, 'update-ref', 'refs/heads/o8/review-preview', sha);
    expect((await workerStream({ jobId: parentId, workerId: 'review-worker', leaseToken: parent.leaseToken,
      type: 'completed', payload: { commitSha: sha, result: 'pushed fixture' } })).status).toBe(200);
    expect((await getTaskPoolTask('packet-review-preview'))!.execution!.previewAccess).toBe('requestable');
    const opened = await openPreview(parentId, 1);
    expect(opened.status).toBe(202);
    const access = await opened.json();
    const child = getJob('team_default', access.serviceJobId)!;
    childId = child.id; absoluteDeadline = access.expiresAt;
    expect(child).toMatchObject({ parentJobId: parentId, status: 'pending', packetId: undefined });
    expect(child.sessionId).not.toBe(getJob('team_default', parentId)!.sessionId);
    expect(child.launch).toMatchObject({ remoteSource: { baseSha: sha }, remoteServiceSession: {
      parentJobId: parentId, parentAttempt: 1, expiresAt: access.expiresAt,
    } });
    closeDb();
    expect((await (await openPreview(parentId, 1)).json()).serviceJobId).toBe(child.id);
    expect(listJobs('team_default').filter((job) => job.parentJobId === parentId)).toHaveLength(1);
    expect(getLatestPacketJob('team_default', 'packet-review-preview')!.id).toBe(parentId);
    expect(getJob('team_default', parentId)!.status).toBe('completed');
    expect((await workerStream({ jobId: parentId, workerId: 'review-worker', leaseToken: parent.leaseToken,
      type: 'heartbeat', payload: {} })).status).toBe(409);
    expect(() => queueJobControl({ teamId: 'team_default', sessionId: child.sessionId,
      controlId: 'no-steer', type: 'steer', payload: { message: 'Do more work' } })).toThrow(/service/);
  });

  it.skipIf(process.platform !== 'linux')('starts no agent, serves the completed result, recovers and closes the remote process', async () => {
    const bin = join(dataDir, 'service-bin'); mkdirSync(bin);
    const invoked = join(dataDir, 'unexpected-agent');
    const ordinary = join(dataDir, 'ordinary-agent');
    writeFileSync(join(bin, 'codex'), `#!/usr/bin/env node\nlet prompt='';process.stdin.on('data',s=>prompt+=s);process.stdin.on('end',()=>{if(prompt.trim()!=='ordinary-fixture'){require('fs').writeFileSync(${JSON.stringify(invoked)},prompt);process.exit(91);}require('fs').appendFileSync(${JSON.stringify(ordinary)},JSON.stringify({prompt,args:process.argv.slice(2)})+'\\n');require('fs').writeFileSync('ordinary-proof.txt','done');process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'done'}})+'\\n');});\n`);
    chmodSync(join(bin, 'codex'), 0o755);
    execFileSync(process.execPath, ['scripts/build-worker.mjs'], { cwd: process.cwd() });
    const bridge = await relayBridge();
    const start = () => spawn(process.execPath, [join(process.cwd(), 'dist/worker/o8-worker.mjs'),
      '--o8-url', bridge.url, '--workspace-dir', join(dataDir, 'service-worker'), '--worker-id', 'service-worker',
      '--poll-interval-ms', '1000', '--control-poll-interval-ms', '1000'], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, O8_CLOUD_WORKER_KEY: key.plaintext,
        GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.file://${bare}/.insteadOf`, GIT_CONFIG_VALUE_0: 'ssh://git@example.invalid/fixture.git' },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let worker = start();
    let output = ''; const capture = () => worker.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); }); capture();
    const stop = async () => { worker.kill('SIGTERM'); await new Promise<void>((resolve) => {
      if (worker.exitCode !== null) resolve(); else worker.once('exit', () => resolve());
    }); };
    const healthy = () => waitFor(() => readJobEvents('team_default', childId).some((event) => event.type === 'service'
      && (event.payload as { state: string; claimCount: number }).state === 'healthy'
      && (event.payload as { claimCount: number }).claimCount === getJob('team_default', childId)!.claimCount) ? true : null,
      () => JSON.stringify({ status: getJob('team_default', childId)?.status,
        deadline: getJob('team_default', childId)?.launch.remoteServiceSession?.expiresAt, output }));
    const read = async (access: { url: string }) => {
      const handshake = await fetch(access.url, { redirect: 'manual' }); expect(handshake.status).toBe(303);
      const response = await fetch(new URL(access.url).origin + '/', { headers: { cookie: handshake.headers.get('set-cookie')!.split(';')[0]! } });
      expect(response.status, output).toBe(200); expect(await response.text()).toContain('Owned remote preview');
    };
    try {
      await healthy();
      let response = await openPreview(parentId, 1); expect(response.status, output).toBe(200);
      const access = await response.json(); await read(access);
      expect(access.serviceJobId).toBe(childId); expect(access.expiresAt).toBe(absoluteDeadline);
      enqueueCloudJob('team_default', 'ordinary-during-preview', { cwd: '', prompt: 'ordinary-fixture',
        model: 'gpt-6.1-sol', effort: 'medium', remoteSource: { ...getJob('team_default', parentId)!.launch.remoteSource!, branch: 'o8/ordinary-preview-fixture' } });
      await waitFor(() => getJob('team_default', 'ordinary-during-preview')?.status === 'completed' ? true : null);
      await read(await (await openPreview(parentId, 1)).json());
      const invocation = JSON.parse(readFileSync(ordinary, 'utf8').trim());
      expect(invocation.args).toEqual(expect.arrayContaining(['--model', 'gpt-6.1-sol', 'model_reasoning_effort=medium']));
      const other = createCloudWorkerKey({ teamId: 'team_default', label: 'different credential fixture' });
      const child = getJob('team_default', childId)!;
      const forged = await streamRoute.POST(new Request('http://localhost/api/cloud/worker-stream', {
        method: 'POST', headers: { authorization: `Bearer ${other.plaintext}`, 'content-type': 'application/json' },
        body: JSON.stringify({ jobId: childId, workerId: child.claimedBy, leaseToken: child.leaseToken, type: 'heartbeat', payload: {} }),
      }));
      expect(forged.status).toBe(403);
      closeDb(); closePreviewServers();
      response = await openPreview(parentId, 1); expect(response.status).toBe(200);
      const reopened = await response.json(); await read(reopened);
      expect(reopened.serviceJobId).toBe(childId); expect(reopened.expiresAt).toBe(absoluteDeadline);
      await stop();
      // This persisted time change replaces sleeping through the full lease interval.
      getSqlite().prepare('UPDATE cloud_jobs SET lease_expires_at = ? WHERE id = ? AND lease_token = ?')
        .run(Date.now() - 1, childId, child.leaseToken);
      worker = start(); capture();
      await waitFor(() => getJob('team_default', childId)?.claimCount === 2 ? true : null);
      await healthy();
      // The old listener must not cancel this recovered attempt when its timer fires.
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      expect(getJob('team_default', childId)!.status, output).toBe('leased');
      response = await openPreview(parentId, 1); expect(response.status).toBe(200);
      const recovered = await response.json(); await read(recovered);
      expect(recovered.expiresAt).toBe(absoluteDeadline);
      const closed = await previewRoute.DELETE(new NextRequest('http://localhost/api/tasks/packet-review-preview/preview', {
        method: 'DELETE', headers: { authorization: `Bearer ${getOrCreateWsToken()}`, 'content-type': 'application/json' },
        body: JSON.stringify({ id: recovered.id, serviceJobId: childId }),
      }), { params: Promise.resolve({ taskId: 'packet-review-preview' }) });
      expect(closed.status).toBe(200);
      await waitFor(() => getJob('team_default', childId)?.status === 'cancelled' ? true : null);
      await waitFor(() => {
        try { execFileSync(process.execPath, ['-e', `require('net').connect(${servicePort},'127.0.0.1').on('connect',()=>process.exit(1)).on('error',()=>process.exit(0))`], { stdio: 'pipe' }); return true; }
        catch { return null; }
      });
      // A health failure is observed without opening a listener or sending preview traffic.
      const failed = await (await openPreview(parentId, 1)).json(); childId = failed.serviceJobId;
      await healthy();
      const checkout = readdirSync(join(dataDir, 'service-worker')).find((name) => name.startsWith(childId + '-'))!;
      writeFileSync(join(dataDir, 'service-worker', checkout, 'repo', 'unhealthy'), 'yes');
      await waitFor(() => getJob('team_default', childId)?.status === 'parked' ? true : null);
      worker.kill('SIGSTOP');
      const expiring = await (await openPreview(parentId, 1)).json(); childId = expiring.serviceJobId;
      const expiringJob = getJob('team_default', childId)!;
      // The absolute deadline includes checkout and health startup; allow that work
      // to finish under CI load while still proving a short, non-renewable lifetime.
      const expiredLaunch = { ...expiringJob.launch, remoteServiceSession: { ...expiringJob.launch.remoteServiceSession!, expiresAt: new Date(Date.now() + 12_000).toISOString() } };
      getSqlite().prepare('UPDATE cloud_jobs SET launch_json = ? WHERE id = ?').run(JSON.stringify(expiredLaunch), childId);
      worker.kill('SIGCONT');
      await healthy();
      await waitFor(() => getJob('team_default', childId)?.status === 'cancelled' ? true : null);
      await waitFor(() => {
        try { execFileSync(process.execPath, ['-e', `require('net').connect(${servicePort},'127.0.0.1').on('connect',()=>process.exit(1)).on('error',()=>process.exit(0))`], { stdio: 'pipe' }); return true; }
        catch { return null; }
      });
      expect(existsSync(invoked)).toBe(false);
      expect(readFileSync(ordinary, 'utf8').trim().split('\n')).toHaveLength(1);
      expect(getLatestPacketJob('team_default', 'packet-review-preview')!.id).toBe(parentId);
      expect(getJob('team_default', parentId)!.status).toBe('completed');
      expect(git('--git-dir', bare, 'rev-parse', 'refs/heads/o8/review-preview')).toBe(getJob('team_default', childId)!.launch.remoteSource!.baseSha);
      expect(output).not.toContain(key.plaintext);
    } finally { worker.kill('SIGCONT'); closePreviewServers(); await stop(); await bridge.close(); }
  }, 60_000);

  it('rejects revoked child credentials and superseded parents after reopening persisted state', async () => {
    const opened = await openPreview(parentId, 1); expect(opened.status).toBe(202);
    const sessionId = (await opened.json()).serviceJobId;
    const credential = createCloudWorkerKey({ teamId: 'team_default', label: 'service revoke fixture' });
    const claim = await pollRoute.GET(new Request('http://localhost/api/cloud/worker-poll?workerId=guard-worker&waitMs=0', {
      headers: { authorization: `Bearer ${credential.plaintext}` },
    }));
    const claimedSession = getJob('team_default', sessionId)!;
    expect(claim.status, JSON.stringify({ status: claimedSession.status, claimedBy: claimedSession.claimedBy, claimCount: claimedSession.claimCount })).toBe(200);
    expect((await claim.json()).job.id).toBe(sessionId);
    revokeCloudWorkerKey(credential.record.id); closeDb();
    new SqliteCloudJobStore().recoverExpiredLeases('team_default');
    expect(getJob('team_default', sessionId)!.status).toBe('cancelled');
    expect((await pollRoute.GET(new Request('http://localhost/api/cloud/worker-poll?workerId=guard-worker&waitMs=0', {
      headers: { authorization: `Bearer ${key.plaintext}` },
    }))).status).toBe(204);
    const next = (await (await openPreview(parentId, 1)).json()).serviceJobId;
    const parent = getJob('team_default', parentId)!;
    enqueueCloudJob('team_default', 'superseding-result', { ...parent.launch, clientMutationId: 'superseding-result' });
    closeDb(); new SqliteCloudJobStore().recoverExpiredLeases('team_default');
    expect(getJob('team_default', next)!.status).toBe('cancelled');
    expect((await openPreview(parentId, 1)).status).toBe(409);
    expect(getJob('team_default', parentId)!.status).toBe('completed');
  });
});
