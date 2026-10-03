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
  const manifest = { version: 1, services: [{ name: 'web', command: 'exec node service.js', port: { preferred: servicePort, env: 'PORT' }, health: { http: `http://127.0.0.1:${servicePort}/health` } }], preview: { url: `http://127.0.0.1:${servicePort}` } };
  writeFileSync(join(repoPath, 'o8.workspace.json'), JSON.stringify(manifest));
  writeFileSync(join(repoPath, 'service.js'), `require('http').createServer((req,res)=>{res.setHeader('content-type','text/html');res.setHeader('x-fixture-pid',String(process.pid));if(require('fs').existsSync('unhealthy'))res.statusCode=503;res.end(req.url==='/health'?'ok':'<h1>Owned remote preview</h1>')}).listen(process.env.PORT,'127.0.0.1')`);
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

async function relayBridge(options: { holdAfterFirstClaim?: boolean } = {}) {
  let hasClaimed = false;
  let rejectControl = false;
  let interruptJobId: string | null = null;
  let interruptMode: 'before' | 'after' | 'expired' | 'exhausted' | 'hung' = 'after';
  const confirmedHeartbeats = new Map<string, string>();
  const consumedHeartbeats = new Map<string, string>();
  const heartbeatLoss = {
    dropped: 0, recovered: false, lastConfirmedExpiry: '', renewedExpiry: '',
    eventId: 0, healthAtDrop: 0, processAtDrop: '', droppedAt: 0, attempts: 0, heldClosed: false, persistedHeartbeatsAtLoss: 0,
  };
  const recordLoss = async (jobId: string, renewal?: { leaseExpiresAt: string; eventId: number }) => {
    const health = await fetch(`http://127.0.0.1:${servicePort}/health`, { signal: AbortSignal.timeout(1_500) });
    await health.body?.cancel();
    Object.assign(heartbeatLoss, {
      dropped: heartbeatLoss.dropped + 1, lastConfirmedExpiry: confirmedHeartbeats.get(jobId) ?? '',
      renewedExpiry: renewal?.leaseExpiresAt ?? '', eventId: renewal?.eventId ?? 0,
      healthAtDrop: health.status, processAtDrop: health.headers.get('x-fixture-pid'), droppedAt: Date.now(),
      persistedHeartbeatsAtLoss: readJobEvents('team_default', jobId).filter((event) => event.type === 'heartbeat').length,
    });
  };
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
      const body = parts.length && url.pathname === '/api/cloud/worker-stream'
        ? JSON.parse(Buffer.concat(parts).toString()) as { jobId: string; type: string } : null;
      const targetedHeartbeat = body?.type === 'heartbeat' && body.jobId === interruptJobId;
      if (targetedHeartbeat && !heartbeatLoss.recovered) {
        heartbeatLoss.attempts += 1;
        if ((interruptMode === 'before' && heartbeatLoss.dropped === 0) || interruptMode === 'exhausted') {
          if (heartbeatLoss.dropped === 0) await recordLoss(body!.jobId);
          else heartbeatLoss.dropped += 1;
          outgoing.destroy();
          return;
        }
      }
      const request = new NextRequest(url, {
        method: incoming.method, headers: new Headers(incoming.headers as HeadersInit), signal: controller.signal,
        ...(parts.length ? { body: Buffer.concat(parts) } : {}),
      });
      if (isPoll) pollingWorkers.add(workerId);
      // Keep recovery observations bound to the original claim. Otherwise the
      // parallel long poll can correctly reclaim an expired lease and its new
      // heartbeat ACK would be mistaken for recovery of the rejected old one.
      if (isPoll && options.holdAfterFirstClaim && hasClaimed) {
        await new Promise<void>((resolve) => {
          if (controller.signal.aborted) resolve();
          else controller.signal.addEventListener('abort', () => resolve(), { once: true });
        });
        return;
      }
      const response = isPoll ? await pollRoute.GET(request)
        : url.pathname === '/api/cloud/worker-stream' ? await streamRoute.POST(request)
          : url.pathname === '/api/cloud/worker-control' ? incoming.method === 'POST' ? await controlRoute.POST(request)
            : rejectControl ? new Response(null, { status: 503 }) : await controlRoute.GET(request)
            : url.pathname === '/api/cloud/worker-preview' ? incoming.method === 'POST' ? await relayRoute.POST(request) : await relayRoute.GET(request)
              : new Response('Not found', { status: 404 });
      if (isPoll && response.ok && response.status !== 204) hasClaimed = true;
      if (body?.type === 'heartbeat' && response.ok) {
        const renewal = await response.clone().json() as { leaseExpiresAt: string; eventId: number };
        if (targetedHeartbeat && heartbeatLoss.dropped === 0) {
          // Route persistence precedes socket loss. Do not send even response headers.
          await recordLoss(body.jobId, renewal);
          if (interruptMode === 'expired') {
            // Lose coordinator authority explicitly, without altering the session deadline.
            getSqlite().prepare('UPDATE cloud_jobs SET lease_expires_at = ? WHERE id = ?').run(Date.now() - 1, body.jobId);
          }
          if (interruptMode === 'hung') {
            await new Promise<void>((resolve) => {
              if (controller.signal.aborted) resolve();
              else controller.signal.addEventListener('abort', () => resolve(), { once: true });
            });
            heartbeatLoss.heldClosed = true;
            return;
          }
          outgoing.destroy();
          return;
        }
        outgoing.once('finish', () => { confirmedHeartbeats.set(body.jobId, renewal.leaseExpiresAt); });
      }
      // A subsequent control GET proves the worker parsed a later heartbeat ACK.
      if (url.pathname === '/api/cloud/worker-control' && incoming.method === 'GET' && response.status === 204) {
        const jobId = url.searchParams.get('jobId')!;
        const confirmed = confirmedHeartbeats.get(jobId);
        if (confirmed) consumedHeartbeats.set(jobId, confirmed);
      }
      if (url.pathname === '/api/cloud/worker-control' && incoming.method === 'GET'
        && url.searchParams.get('jobId') === interruptJobId && response.status === 204
        && heartbeatLoss.dropped === 1
        && Date.parse(confirmedHeartbeats.get(interruptJobId!) ?? '') > Date.parse(heartbeatLoss.renewedExpiry || heartbeatLoss.lastConfirmedExpiry)) {
        heartbeatLoss.recovered = true;
      }
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
    heartbeatLoss, confirmedAuthority: (jobId: string) => consumedHeartbeats.get(jobId),
    interruptHeartbeat: (jobId: string, mode: typeof interruptMode = 'after') => { interruptJobId = jobId; interruptMode = mode; },
    failControl: () => { rejectControl = true; },
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

  it.skipIf(process.platform !== 'linux').each(['after', 'before', 'expired', 'exhausted', 'hung'] as const)(
    'bounds healthy service heartbeat recovery under %s acknowledgement loss', async (mode) => {
    const bin = join(dataDir, `heartbeat-loss-${mode}-bin`); mkdirSync(bin);
    const invoked = join(dataDir, `heartbeat-loss-${mode}-unexpected-agent`);
    writeFileSync(join(bin, 'codex'), `#!/bin/sh\nprintf unexpected > '${invoked}'\nexit 91\n`);
    chmodSync(join(bin, 'codex'), 0o755);
    const parentBefore = getJob('team_default', parentId)!;
    const allocated = await openPreview(parentId, 1);
    expect(allocated.status).toBe(202);
    const access = await allocated.json();
    const recoveryChildId = access.serviceJobId as string;
    const bridge = await relayBridge({ holdAfterFirstClaim: true });
    let worker: ReturnType<typeof spawn> | null = null;
    let output = '';
    let servicePid = 0;
    let serviceStartTime: string | undefined;
    let previewId: string | undefined;
    let previewOrigin: string | undefined;
    const originalLeaseMs = process.env.O8_CLOUD_JOB_LEASE_MS;
    const healthyEvents = () => readJobEvents('team_default', recoveryChildId).filter((event) => event.type === 'service'
      && (event.payload as { state: string }).state === 'healthy');
    const diagnostics = () => JSON.stringify({ transport: bridge.heartbeatLoss,
      child: (() => {
        const job = getJob('team_default', recoveryChildId);
        return { id: job?.id, status: job?.status, claim: job?.claimCount, worker: job?.claimedBy,
          attempt: job?.executionAttempts, leaseExpiresAt: job?.leaseExpiresAt,
          absoluteDeadline: job?.launch.remoteServiceSession?.expiresAt };
      })(), events: readJobEvents('team_default', recoveryChildId).filter((event) => ['heartbeat', 'errored', 'service'].includes(event.type)), output });
    const health = async () => {
      const response = await fetch(`http://127.0.0.1:${servicePort}/health`, { signal: AbortSignal.timeout(1_500) });
      await response.body?.cancel();
      expect(response.status, diagnostics()).toBe(200);
      return Number(response.headers.get('x-fixture-pid'));
    };
    const closePreview = () => previewRoute.DELETE(new NextRequest('http://localhost/api/tasks/packet-review-preview/preview', {
      method: 'DELETE', headers: { authorization: `Bearer ${getOrCreateWsToken()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ id: previewId, serviceJobId: recoveryChildId }),
    }), { params: Promise.resolve({ taskId: 'packet-review-preview' }) });
    try {
      execFileSync(process.execPath, ['scripts/build-worker.mjs']);
      worker = spawn(process.execPath, [join(process.cwd(), 'dist/worker/o8-worker.mjs'),
        '--o8-url', bridge.url, '--workspace-dir', join(dataDir, `heartbeat-loss-${mode}-worker`), '--worker-id', `heartbeat-loss-${mode}-worker`,
        '--poll-interval-ms', '60000', '--control-poll-interval-ms', '1000'], {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, O8_CLOUD_WORKER_KEY: key.plaintext,
          GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.file://${bare}/.insteadOf`, GIT_CONFIG_VALUE_0: 'ssh://git@example.invalid/fixture.git' },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      worker.stderr!.on('data', (chunk: Buffer) => { output += chunk.toString(); });
      await waitFor(() => healthyEvents().length === 1 ? true : null, diagnostics);
      servicePid = await health();
      expect(servicePid).toBeGreaterThan(0);
      const serviceStat = readFileSync(`/proc/${servicePid}/stat`, 'utf8');
      const serviceFields = serviceStat.slice(serviceStat.lastIndexOf(')') + 2).split(' ');
      expect(Number(serviceFields[2])).toBe(servicePid);
      serviceStartTime = serviceFields[19];
      if (mode === 'before' || mode === 'after') {
        const opened = await openPreview(parentId, 1);
        expect(opened.status).toBe(200);
        const preview = await opened.json();
        expect(preview.serviceJobId).toBe(recoveryChildId);
        expect(preview.expiresAt).toBe(access.expiresAt);
        previewId = preview.id;
        previewOrigin = new URL(preview.url).origin;
        const handshake = await fetch(preview.url, { redirect: 'manual', signal: AbortSignal.timeout(1_500) });
        await handshake.body?.cancel();
        expect(handshake.status).toBe(303);
      }
      if (mode === 'hung') {
        // First ACK a genuinely shorter coordinator lease, then hold the next
        // renewal ACK. The worker must use the shorter known bound, not the
        // longer renewal that will persist behind the held response.
        const previous = bridge.confirmedAuthority(recoveryChildId);
        process.env.O8_CLOUD_JOB_LEASE_MS = '6000';
        await waitFor(() => {
          const confirmed = bridge.confirmedAuthority(recoveryChildId);
          return confirmed && confirmed !== previous ? true : null;
        }, diagnostics);
        process.env.O8_CLOUD_JOB_LEASE_MS = originalLeaseMs;
      }
      const before = getJob('team_default', recoveryChildId)!;
      const healthyReceipt = healthyEvents()[0]!;
      const heartbeatCount = readJobEvents('team_default', recoveryChildId).filter((event) => event.type === 'heartbeat').length;
      bridge.interruptHeartbeat(recoveryChildId, mode);
      await waitFor(() => bridge.heartbeatLoss.dropped >= 1 ? true : null, diagnostics);
      const loss = bridge.heartbeatLoss;
      // Raw evidence distinguishes a lost response from health or authority loss.
      console.log('[heartbeat-loss] persisted renewal and last confirmed worker authority', diagnostics());
      expect(loss.healthAtDrop).toBe(200);
      expect(Number(loss.processAtDrop)).toBe(servicePid);
      expect(Date.parse(loss.lastConfirmedExpiry)).toBeGreaterThan(loss.droppedAt);
      if (mode !== 'before' && mode !== 'exhausted') {
        expect(loss.persistedHeartbeatsAtLoss).toBe(heartbeatCount + 1);
        expect(Date.parse(loss.renewedExpiry)).toBeGreaterThan(Date.parse(loss.lastConfirmedExpiry));
        expect(Date.parse(loss.renewedExpiry)).toBeLessThanOrEqual(Date.parse(access.expiresAt));
        expect(readJobEvents('team_default', recoveryChildId).find((event) => event.id === loss.eventId)?.type).toBe('heartbeat');
      } else {
        expect(loss.eventId).toBe(0);
        expect(loss.persistedHeartbeatsAtLoss).toBe(heartbeatCount);
      }
      // Terminal state ends the barrier promptly on current immediate-abort code.
      await waitFor(() => {
        if (loss.recovered) return true;
        if (mode === 'expired') return output.includes('heartbeat failed: [worker/cloud] /api/cloud/worker-stream rejected with HTTP 409') ? true : null;
        return getJob('team_default', recoveryChildId)?.status !== 'leased' ? true : null;
      }, diagnostics);
      const recoverable = mode === 'after' || mode === 'before';
      expect(loss.recovered, diagnostics()).toBe(recoverable);
      closeDb();
      const after = getJob('team_default', recoveryChildId)!;
      expect(after).toMatchObject({ id: before.id, claimCount: before.claimCount,
        launch: { remoteServiceSession: { expiresAt: access.expiresAt } } });
      expect(healthyEvents()).toEqual([healthyReceipt]);
      if (recoverable) {
        expect(after).toMatchObject({ status: 'leased', claimedBy: before.claimedBy,
          leaseToken: before.leaseToken, executionAttempts: before.executionAttempts });
        expect(loss.attempts, diagnostics()).toBeGreaterThanOrEqual(2);
        expect(loss.attempts, diagnostics()).toBeLessThanOrEqual(3);
        expect(await health()).toBe(servicePid);
        process.kill(servicePid, 0);
      } else if (mode === 'expired') {
        expect(after).toMatchObject({ status: 'pending', executionAttempts: before.executionAttempts,
          leaseRecoveryCount: before.leaseRecoveryCount + 1 });
        expect(after.leaseToken).toBeUndefined();
        expect(loss.attempts).toBe(2);
        expect(readJobEvents('team_default', recoveryChildId).filter((event) => event.type === 'heartbeat')).toHaveLength(heartbeatCount + 1);
      } else {
        expect(after).toMatchObject({ status: 'parked', executionAttempts: before.executionAttempts + 1 });
        expect(loss.attempts).toBe(mode === 'exhausted' ? 3 : 1);
        const failure = readJobEvents('team_default', recoveryChildId).find((event) => event.type === 'errored');
        expect((failure?.payload as { message: string }).message).toContain(mode === 'exhausted'
          ? 'heartbeat failed: fetch failed; heartbeat transport recovery exhausted after 3 attempts'
          : 'lease renewal was not confirmed before expiry');
        if (mode === 'hung') {
          await waitFor(() => loss.heldClosed ? true : null, diagnostics);
          expect(Date.parse(failure!.createdAt)).toBeLessThan(Date.parse(loss.lastConfirmedExpiry));
          expect(Date.parse(loss.renewedExpiry)).toBeGreaterThan(Date.parse(loss.lastConfirmedExpiry));
        }
      }
      if (recoverable) {
        expect((await closePreview()).status).toBe(200);
        await waitFor(() => getJob('team_default', recoveryChildId)?.status === 'cancelled' ? true : null, diagnostics);
      }
      // Product cleanup must finish while the worker remains online. SIGTERM
      // in fallback teardown cannot satisfy these success-path assertions.
      expect(worker.exitCode, diagnostics()).toBeNull();
      expect(worker.signalCode, diagnostics()).toBeNull();
      await waitFor(() => {
        try { process.kill(servicePid, 0); return null; } catch { return true; }
      }, diagnostics);
      await expect(fetch(`http://127.0.0.1:${servicePort}/health`, { signal: AbortSignal.timeout(1_500) })).rejects.toThrow();
      if (previewOrigin) await expect(fetch(previewOrigin, { signal: AbortSignal.timeout(1_500) })).rejects.toThrow();
      expect(worker.exitCode, diagnostics()).toBeNull();
      expect(worker.signalCode, diagnostics()).toBeNull();
      closeDb();
      // DELETE and expired authority clear the claim before a cleanup receipt
      // can persist. Those cases prove cancellation/recovery plus live-worker
      // PID/listener exit above; only still-authorized failures emit stopped.
      if (mode === 'exhausted' || mode === 'hung') {
        expect(readJobEvents('team_default', recoveryChildId).filter((event) => event.type === 'service').at(-1)?.payload)
          .toMatchObject({ state: 'stopped' });
      }
      expect(getJob('team_default', parentId)).toEqual(parentBefore);
      expect(existsSync(invoked)).toBe(false);
      expect(output).not.toContain(key.plaintext);
    } finally {
      process.env.O8_CLOUD_JOB_LEASE_MS = originalLeaseMs;
      // Close even on red; stop the worker before dropping the bridge so receipts can persist.
      try {
        try {
          await closePreview();
        } finally {
          if (worker && worker.exitCode === null && worker.signalCode === null) {
            worker.kill('SIGTERM');
            await new Promise<void>((resolve) => {
              const force = setTimeout(() => worker!.kill('SIGKILL'), 8_000);
              worker!.once('exit', () => { clearTimeout(force); resolve(); });
            });
          }
        }
        expect(existsSync(invoked)).toBe(false);
      } finally {
        // Red-path fallback only: kill the owned exec fixture group if a broken
        // worker left it behind. Start time prevents signalling a reused PID.
        if (servicePid && serviceStartTime) {
          try {
            const stat = readFileSync(`/proc/${servicePid}/stat`, 'utf8');
            const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
            if (fields[19] === serviceStartTime && Number(fields[2]) === servicePid) process.kill(-servicePid, 'SIGKILL');
          } catch { /* The owned process already exited. */ }
        }
        closePreviewServers(); await bridge.close();
      }
    }
  }, 60_000);

  it.skipIf(process.platform !== 'linux')('persists the control failure that stopped a healthy preview and closes its process', async () => {
    const bin = join(dataDir, 'failure-bin'); mkdirSync(bin);
    const invoked = join(dataDir, 'failure-unexpected-agent');
    writeFileSync(join(bin, 'codex'), `#!/bin/sh\nprintf unexpected > '${invoked}'\nexit 91\n`);
    chmodSync(join(bin, 'codex'), 0o755);
    execFileSync(process.execPath, ['scripts/build-worker.mjs']);
    const allocated = await openPreview(parentId, 1);
    expect(allocated.status).toBe(202);
    const failedChildId = (await allocated.json()).serviceJobId;
    const bridge = await relayBridge();
    const worker = spawn(process.execPath, [join(process.cwd(), 'dist/worker/o8-worker.mjs'),
      '--o8-url', bridge.url, '--workspace-dir', join(dataDir, 'failure-worker'), '--worker-id', 'failure-worker',
      '--poll-interval-ms', '60000', '--control-poll-interval-ms', '1000'], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, O8_CLOUD_WORKER_KEY: key.plaintext,
        GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.file://${bare}/.insteadOf`, GIT_CONFIG_VALUE_0: 'ssh://git@example.invalid/fixture.git' },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let output = '';
    worker.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    try {
      await waitFor(() => readJobEvents('team_default', failedChildId).some((event) => event.type === 'service'
        && (event.payload as { state: string }).state === 'healthy') ? true : null, () => output);
      bridge.failControl();
      await waitFor(() => getJob('team_default', failedChildId)?.status === 'parked' ? true : null, () => output);
      closeDb();
      const failure = readJobEvents('team_default', failedChildId).find((event) => event.type === 'errored');
      expect(failure?.payload).toMatchObject({ message: '[worker] control poll failed: [worker/cloud] /api/cloud/worker-control rejected with HTTP 503' });
      const stopped = readJobEvents('team_default', failedChildId).filter((event) => event.type === 'service').at(-1);
      expect(stopped?.payload).toMatchObject({ state: 'stopped' });
      await expect(fetch(`http://127.0.0.1:${servicePort}/health`)).rejects.toThrow();
      expect(existsSync(invoked)).toBe(false);
      expect(getJob('team_default', parentId)!.status).toBe('completed');
      expect(output).not.toContain(key.plaintext);
    } finally {
      closePreviewServers();
      if (worker.exitCode === null && worker.signalCode === null) {
        worker.kill('SIGTERM');
        await new Promise<void>((resolve) => worker.once('exit', () => resolve()));
      }
      await bridge.close();
    }
  }, 25_000);

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
