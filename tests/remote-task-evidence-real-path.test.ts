import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/cortex/spec-ingest', () => ({
  ingestRepoSpecs: vi.fn(async () => ({ scannedFiles: 0, writtenDirectives: 0, deletedStaleDirectives: 0 })),
  purgeOrphanedSpecDirectives: vi.fn(async () => 0),
}));
const dataDir = mkdtempSync(join(tmpdir(), 'o8-remote-evidence-'));
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_CLOUD_JOB_LEASE_MS = '500';
const repoPath = join(dataDir, 'repo');
const runtimeRoute = await import('@/app/api/runtime/launch/route');
const pollRoute = await import('@/app/api/cloud/worker-poll/route');
const streamRoute = await import('@/app/api/cloud/worker-stream/route');
const taskEvidenceRoute = await import('@/app/api/tasks/[taskId]/evidence/route');
const { addRepo } = await import('@/lib/repos/registry');
const { createCloudWorkerKey } = await import('@/lib/cloud/worker-auth');
const { getJob, cancelJob } = await import('@/lib/cloud/job-queue');
const { SqliteCloudJobStore } = await import('@/lib/cloud/sqlite-job-store');
const projectContext = await import('@/lib/projects/context');
const taskPool = await import('@/lib/tasks/pool');
const { closeDb } = await import('@/lib/db');
const { getOrCreateWsToken } = await import('@/lib/ws-auth');
const { readOrchestratorControlPlaneState, writeOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
const key = createCloudWorkerKey({ teamId: 'team_default', label: 'evidence fixture' });
function git(...args: string[]) { return execFileSync('git', args, { stdio: 'pipe' }).toString().trim(); }
const published = await import('@/lib/cloud/published-base');
vi.spyOn(published, 'resolvePublishedCloudBase').mockImplementation(async () => git('-C', repoPath, 'rev-parse', 'HEAD'));
beforeAll(async () => {
  mkdirSync(repoPath);
  git('init', '-b', 'main', repoPath);
  git('-C', repoPath, 'config', 'user.name', 'Test');
  git('-C', repoPath, 'config', 'user.email', 'test@example.invalid');
  writeFileSync(join(repoPath, 'README.md'), 'Fixture\n');
  git('-C', repoPath, 'add', '.');
  git('-C', repoPath, 'commit', '-m', 'test: fixture');
  git('-C', repoPath, 'remote', 'add', 'origin', 'https://example.invalid/fixture.git');
  await addRepo(repoPath);
  const state = readOrchestratorControlPlaneState();
  writeOrchestratorControlPlaneState({ ...state, repoPath, runtime: 'codex', packets: [{
    id: 'packet-cloud-evidence', referenceLabel: 'packet-cloud-evidence', title: 'Remote evidence fixture', summary: 'Evidence fixture',
    status: 'draft', queueState: 'queued', releaseState: 'pending', blockedReason: null,
    lane: null, review: null, runtime: 'cloud', workspaceTargetPath: repoPath,
    branchTarget: 'o8/cloud-evidence', dependencyPacketIds: [], dependencyLabels: [], attemptCount: 0,
    lastEventAt: new Date().toISOString(), lastEventLabel: 'created', recoveryCount: 0, typecheckAutoRetries: 0,
    orchestratorThreadId: null,
  }] } as Parameters<typeof writeOrchestratorControlPlaneState>[0]);
  const initialized = readOrchestratorControlPlaneState();
  writeOrchestratorControlPlaneState({ ...initialized, packets: [...initialized.packets, { ...initialized.packets[0]!, id: 'packet-cloud-invalid-source' }] });
});
afterAll(() => { vi.restoreAllMocks(); closeDb(); rmSync(dataDir, { recursive: true, force: true }); });
function runtimeLaunch(body: unknown) {
  return runtimeRoute.POST(new NextRequest('http://localhost/api/runtime/launch', {
    method: 'POST', headers: { Authorization: `Bearer ${getOrCreateWsToken()}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }));
}
function workerPoll(workerId: string, cursor: number) {
  return pollRoute.GET(new NextRequest(`http://localhost/api/cloud/worker-poll?waitMs=0&workerId=${workerId}&cursor=${cursor}`, { headers: { Authorization: `Bearer ${key.plaintext}` } }));
}
function workerStream(body: unknown) {
  return streamRoute.POST(new NextRequest('http://localhost/api/cloud/worker-stream', { method: 'POST', headers: { Authorization: `Bearer ${key.plaintext}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
}
describe('remote evidence through authenticated task and persisted job routes', () => {
  it('refuses anonymous loopback requests and malformed attempt references', async () => {
    const context = { params: Promise.resolve({ taskId: 'packet-cloud-evidence' }) };
    expect((await taskEvidenceRoute.GET(new NextRequest('http://localhost/api/tasks/packet-cloud-evidence/evidence?jobId=job&attempt=0', { headers: { host: 'localhost' } }), context)).status).toBe(403);
    expect((await taskEvidenceRoute.GET(new NextRequest('http://localhost/api/tasks/packet-cloud-evidence/evidence?jobId=job', { headers: { Authorization: `Bearer ${getOrCreateWsToken()}` } }), context)).status).toBe(400);
  });
  it('opens bounded remote evidence only for the current packet and claim attempt', async () => {
    const previousLease = process.env.O8_CLOUD_JOB_LEASE_MS;
    let evidenceJobId: string | null = null;
    process.env.O8_CLOUD_JOB_LEASE_MS = '500';
    try {
      const packetId = 'packet-cloud-evidence';
      const launch = await runtimeLaunch({
        runtime: 'cloud', prompt: 'Produce remote evidence.', cwd: repoPath, repoPath,
        branchName: 'o8/cloud-evidence', packetId, skipSetup: true,
        clientMutationId: 'cloud-evidence-1',
      });
      expect(launch.status).toBe(200);
      const launched = await launch.json() as { surfaceId: string };
      const jobId = launched.surfaceId.replace(/^cloud:/, '');
      evidenceJobId = jobId;
      const cursor = getJob('team_default', jobId)!.cursor;
      const evidenceRequest = (attempt: number, id = packetId, authenticated = true) => taskEvidenceRoute.GET(
        new NextRequest(`http://example.invalid/api/tasks/${id}/evidence?jobId=${jobId}&attempt=${attempt}`, {
          headers: authenticated ? { authorization: `Bearer ${getOrCreateWsToken()}` } : {},
        }),
        { params: Promise.resolve({ taskId: id }) },
      );
      expect((await evidenceRequest(0)).status).toBe(200);
      expect((await evidenceRequest(0, packetId, false)).status).toBe(401);
      expect((await evidenceRequest(0, 'packet-cloud-invalid-source')).status).toBe(409);
      const firstPoll = await workerPoll('evidence-first', cursor);
      expect(firstPoll.status).toBe(200);
      const firstJob = (await firstPoll.json() as { job: { id: string; claimedBy: string; leaseToken: string } }).job;
      expect(firstJob.id).toBe(jobId);
      expect((await workerStream({ jobId, workerId: firstJob.claimedBy, leaseToken: firstJob.leaseToken, type: 'chunk', payload: { text: 'first attempt log' } })).status).toBe(200);
      expect((await workerStream({ jobId, workerId: firstJob.claimedBy, leaseToken: firstJob.leaseToken, type: 'diff', payload: { files: [{ path: 'first.txt', status: 'added', additions: 1, deletions: 0 }] } })).status).toBe(200);
      const first = await evidenceRequest(1);
      expect(first.status).toBe(200);
      expect(await first.json()).toMatchObject({
        packetId, jobId, attempt: 1,
        logs: [{ text: 'first attempt log' }],
        files: [{ path: 'first.txt', status: 'added' }],
        previewAccess: 'unavailable', workspaceAccess: 'unavailable',
      });
      closeDb();
      expect((await evidenceRequest(1)).status).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 550));
      const secondPoll = await workerPoll('evidence-second', cursor);
      expect(secondPoll.status).toBe(200);
      const secondJob = (await secondPoll.json() as { job: { id: string; claimedBy: string; leaseToken: string } }).job;
      expect(secondJob.id).toBe(jobId);
      expect((await evidenceRequest(1)).status).toBe(409);
      const second = await evidenceRequest(2);
      expect(second.status).toBe(200);
      expect(await second.json()).toMatchObject({ logs: [], files: [], attempt: 2 });
      expect((await workerStream({ jobId, workerId: firstJob.claimedBy, leaseToken: firstJob.leaseToken, type: 'chunk', payload: { text: 'stale worker' } })).status).toBe(409);
      expect((await workerStream({ jobId, workerId: secondJob.claimedBy, leaseToken: secondJob.leaseToken, type: 'chunk', payload: { text: 'second attempt log' } })).status).toBe(200);
      const latest = await evidenceRequest(2);
      expect(await latest.json()).toMatchObject({ logs: [{ text: 'second attempt log' }], files: [] });
      const originalContext = projectContext.getProjectContext;
      const originalTask = taskPool.getTaskPoolTask;
      let poolReads = 0;
      let finalRead = false;
      const taskSpy = vi.spyOn(taskPool, 'getTaskPoolTask').mockImplementation(async (id, options) => {
        finalRead = ++poolReads === 2;
        return originalTask(id, options);
      });
      let reclaimed = false;
      const contextSpy = vi.spyOn(projectContext, 'getProjectContext').mockImplementation(async (options) => {
        const result = await originalContext(options);
        if (finalRead && !reclaimed) {
          const current = getJob('team_default', jobId)!;
          const replacement = new SqliteCloudJobStore().claimNext({
            teamId: 'team_default', cursor, jobId, workerId: 'evidence-third', bootId: 'evidence-race',
            leaseMs: 500, nowMs: Date.parse(current.leaseExpiresAt!) + 1,
          });
          expect(replacement?.claimCount).toBe(3);
          reclaimed = true;
        }
        return result;
      });
      try {
        const interleaved = await evidenceRequest(2);
        expect(reclaimed).toBe(true);
        expect(interleaved.status).toBe(409);
        expect(await interleaved.text()).not.toContain('second attempt log');
        closeDb();
        expect(getJob('team_default', jobId)?.claimCount).toBe(3);
      } finally { contextSpy.mockRestore(); taskSpy.mockRestore(); }

    } finally {
      if (evidenceJobId) cancelJob('team_default', evidenceJobId);
      if (previousLease === undefined) delete process.env.O8_CLOUD_JOB_LEASE_MS;
      else process.env.O8_CLOUD_JOB_LEASE_MS = previousLease;
    }
  });

});
