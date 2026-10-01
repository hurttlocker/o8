import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Background document indexing is outside the dispatch contract and outlives short fixtures.
vi.mock('@/lib/cortex/spec-ingest', () => ({
  ingestRepoSpecs: vi.fn(async () => ({ scannedFiles: 0, writtenDirectives: 0, deletedStaleDirectives: 0 })),
  purgeOrphanedSpecDirectives: vi.fn(async () => 0),
}));

const dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'o8-remote-task-')));
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;
const repoPath = join(dataDir, 'repo');
const remotePath = join(dataDir, 'remote.git');
const tasks = await import('@/app/api/tasks/route');
const dispatch = await import('@/app/api/tasks/[taskId]/dispatch/route');
const availability = await import('@/app/api/tasks/worker-availability/route');
const block = await import('@/app/api/tasks/[taskId]/block/route');
const poll = await import('@/app/api/cloud/worker-poll/route');
const stream = await import('@/app/api/cloud/worker-stream/route');
const { cloudRuntime } = await import('@/lib/runtimes/cloud-adapter');
const { addRepo } = await import('@/lib/repos/registry');
const { createCloudWorkerKey, revokeCloudWorkerKey } = await import('@/lib/cloud/worker-auth');
const { recordCloudWorkerPresence } = await import('@/lib/cloud/worker-presence');
const { getJob } = await import('@/lib/cloud/job-queue');
const { getLane, reconcileLanesWithSessions, detachSession, setLaneStatus } = await import('@/lib/lane/registry');
const { reconcileCloudJobLanes } = await import('@/lib/lane/cloud-reconciliation');
const { closeDb } = await import('@/lib/db');
const { getRuntime } = await import('@/lib/runtimes');
const { getOrCreateWsToken } = await import('@/lib/ws-auth');
const { getWorktreeManager } = await import('@/lib/worktree');
const { readOrchestratorControlPlaneState, writeOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');

function git(...args: string[]) {
  return execFileSync('git', args, { stdio: 'pipe' }).toString().trim();
}
function request(path: string, body?: unknown, authenticated = true) {
  return new NextRequest(`http://localhost${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(authenticated ? { Authorization: `Bearer ${getOrCreateWsToken()}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function create(model?: string, requestedEffort?: string) {
  const response = await tasks.POST(request('/api/tasks', {
    title: 'Remote task fixture', repoPath, requestedRuntime: 'cloud', model, requestedEffort,
  }));
  expect(response.status).toBe(201);
  const body = await response.json();
  expect(body.task.runtime).toBe('cloud');
  expect(body.workerRouting.selectedRuntime).toBe('cloud');
  expect(readOrchestratorControlPlaneState().packets.find((packet) => packet.id === body.taskId))
    .toMatchObject({ runtime: 'cloud', queueState: 'held', holdIntent: 'explicit-dispatch' });
  return body.taskId as string;
}
async function run(taskId: string, requestedEffort?: string) {
  return dispatch.POST(request(`/api/tasks/${taskId}/dispatch`, { repoPath, requestedEffort }), {
    params: Promise.resolve({ taskId }),
  });
}

// External origin transport is substituted with the pinned fixture revision.
const published = await import('@/lib/cloud/published-base');
vi.spyOn(published, 'resolvePublishedCloudBase').mockImplementation(async () => git('-C', repoPath, 'rev-parse', 'main'));

beforeAll(async () => {
  mkdirSync(repoPath);
  git('init', '-b', 'main', repoPath);
  git('-C', repoPath, 'config', 'user.name', 'Test');
  git('-C', repoPath, 'config', 'user.email', 'test@example.invalid');
  writeFileSync(join(repoPath, 'README.md'), 'Fixture\n');
  git('-C', repoPath, 'add', '.');
  git('-C', repoPath, 'commit', '-m', 'test: fixture');
  git('init', '--bare', remotePath);
  git('-C', repoPath, 'remote', 'add', 'origin', remotePath);
  git('-C', repoPath, 'push', 'origin', 'main');
  git('-C', repoPath, 'remote', 'set-url', 'origin', 'https://example.invalid/fixture.git');
  await addRepo(repoPath);
  // Replace only the external origin fetch with the actual fixture base revision.
  vi.spyOn(getWorktreeManager(repoPath), 'resolveCreationBaseCommit').mockResolvedValue(git('-C', repoPath, 'rev-parse', 'main'));
});
afterAll(() => { vi.restoreAllMocks(); closeDb(); rmSync(dataDir, { recursive: true, force: true }); });

describe('remote placement through ordinary authenticated task routes', () => {
  it('requires operator authentication for pool visibility', async () => {
    expect((await availability.GET(request('/api/tasks/worker-availability', undefined, false))).status).toBe(401);
  });

  it('refuses invalid, conflicting and coerced effort before saving a task', async () => {
    const count = readOrchestratorControlPlaneState().packets.length;
    for (const selection of [
      { requestedEffort: 'maximal' },
      { requestedEffort: 'medium', thinkingEffort: 'high' },
      { model: 'gpt-unlisted', requestedEffort: 'ultra' },
    ]) {
      const response = await tasks.POST(request('/api/tasks', {
        title: 'Invalid effort', repoPath, requestedRuntime: 'cloud', model: 'gpt-6.1-sol', ...selection,
      }));
      expect(response.status).toBe(400);
    }
    closeDb();
    expect(readOrchestratorControlPlaneState().packets).toHaveLength(count);
  });

  it('preserves remote placement and refuses absent, stale, other-team, and revoked workers', async () => {
    const taskId = await create();
    const localLaunch = vi.spyOn(getRuntime('codex')!, 'launch');
    expect((await run(taskId)).status).toBe(409);
    const other = createCloudWorkerKey({ teamId: 'team_other', label: 'other-team' });
    recordCloudWorkerPresence({ teamId: 'team_other', keyId: other.record.id, workerId: 'other' });
    expect((await run(taskId)).status).toBe(409);
    const stale = createCloudWorkerKey({ teamId: 'team_default', label: 'stale' });
    recordCloudWorkerPresence({ teamId: 'team_default', keyId: stale.record.id, workerId: 'stale', nowMs: Date.now() - 61_000 });
    expect((await run(taskId)).status).toBe(409);
    const revoked = createCloudWorkerKey({ teamId: 'team_default', label: 'revoked' });
    recordCloudWorkerPresence({ teamId: 'team_default', keyId: revoked.record.id, workerId: 'revoked' });
    revokeCloudWorkerKey(revoked.record.id);
    expect((await run(taskId)).status).toBe(409);
    expect((await (await availability.GET(request('/api/tasks/worker-availability'))).json()).available).toBe(false);
    expect(localLaunch).not.toHaveBeenCalled();
    localLaunch.mockRestore();
  });

  it('queues the exact packet and model for a connected worker without a local worktree or worker', async () => {
    const key = createCloudWorkerKey({ teamId: 'team_default', label: 'connected' });
    const seen = await poll.GET(new NextRequest('http://localhost/api/cloud/worker-poll?waitMs=0&workerId=remote-fixture', {
      headers: { Authorization: `Bearer ${key.plaintext}` },
    }));
    expect(seen.status).toBe(204);
    const ready = await (await availability.GET(request('/api/tasks/worker-availability'))).json();
    expect(ready).toMatchObject({ available: true, connectedWorkers: 1 });
    const localLaunch = vi.spyOn(getRuntime('codex')!, 'launch');
    const taskId = await create('gpt-6.1-sol', 'medium');
    closeDb();
    expect(readOrchestratorControlPlaneState().packets.find((packet) => packet.id === taskId))
      .toMatchObject({ runtime: 'cloud', workerRouting: { requestedEffort: 'medium', selectedEffort: 'medium' } });
    const response = await run(taskId);
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.ok, body.note).toBe(true);
    expect(body.workerRouting).toMatchObject({ selectedRuntime: 'cloud', selectedModel: 'gpt-6.1-sol', selectedEffort: 'medium' });
    expect(readOrchestratorControlPlaneState().packets.find((packet) => packet.id === taskId))
      .toMatchObject({ queueState: 'queued' });
    const lane = getLane(body.laneId)!;
    expect(lane).toMatchObject({ runtime: 'cloud', worktreePath: null, packetId: body.packetId, model: 'gpt-6.1-sol' });
    expect(lane.sessionKey).toMatch(/^cloud:/);
    const job = getJob('team_default', lane.sessionKey!.slice('cloud:'.length))!;
    expect(job).toMatchObject({ packetId: body.packetId, launch: { laneId: lane.id, model: 'gpt-6.1-sol', effort: 'medium' } });
    expect(job.launch.remoteSource).toMatchObject({ repoUrl: 'https://example.invalid/fixture.git', branch: lane.branch });
    const claimedResponse = await poll.GET(new NextRequest('http://localhost/api/cloud/worker-poll?waitMs=0&workerId=remote-fixture', {
      headers: { Authorization: `Bearer ${key.plaintext}` },
    }));
    expect(claimedResponse.status).toBe(200);
    const claimed = (await claimedResponse.json()).job;
    expect(claimed.id).toBe(job.id);
    expect(claimed.launch).toMatchObject({ model: 'gpt-6.1-sol', effort: 'medium' });
    const blocked = await block.POST(request(`/api/tasks/${taskId}/block`, { repoPath, reason: 'Operator review needed', actor: 'user' }), { params: Promise.resolve({ taskId }) });
    expect(blocked.status).toBe(200);
    reconcileCloudJobLanes();
    expect(getLane(lane.id)?.status).toBe('awaiting_orchestrator');
    setLaneStatus(lane.id, 'paused', 'user', 'interrupted');
    reconcileCloudJobLanes();
    expect(getLane(lane.id)?.status).toBe('paused');
    setLaneStatus(lane.id, 'running', 'system', 'fixture_resumed');
    // Replay the historical pre-dispatch marker without changing the job.
    const state = readOrchestratorControlPlaneState();
    writeOrchestratorControlPlaneState({ ...state, packets: state.packets.map((packet) => packet.id === taskId
      ? { ...packet, status: 'blocked', queueState: 'held', holdIntent: 'explicit-dispatch', blockedReason: 'Awaiting explicit dispatch' }
      : packet) });
    closeDb();
    const running = await (await tasks.GET(request('/api/tasks?includeDone=true'))).json();
    expect(running.tasks.find((task: { id: string }) => task.id === taskId))
      .toMatchObject({ group: 'running', blockedReason: null });
    const output = await stream.POST(new NextRequest('http://localhost/api/cloud/worker-stream', {
      method: 'POST', headers: { Authorization: `Bearer ${key.plaintext}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId: job.id, workerId: 'remote-fixture', leaseToken: claimed.leaseToken, type: 'chunk', payload: { text: 'Task worker receipt' } }),
    }));
    expect(output.status).toBe(200);
    closeDb();
    expect(await cloudRuntime.readTranscript(lane.sessionKey!))
      .toEqual(expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining('Task worker receipt') })]));
    expect(git('-C', repoPath, 'worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1);
    expect(localLaunch).not.toHaveBeenCalled();
    expect((await run(await create('claude-invalid-model'))).status).toBe(409);
    const completed = await stream.POST(new NextRequest('http://localhost/api/cloud/worker-stream', {
      method: 'POST', headers: { Authorization: `Bearer ${key.plaintext}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId: job.id, workerId: 'remote-fixture', leaseToken: claimed.leaseToken, type: 'completed', payload: { result: 'done', commitSha: git('-C', repoPath, 'rev-parse', 'main') } }),
    }));
    expect(completed.status).toBe(200);
    // Local CLI inventory cannot detach a durable remote session.
    reconcileLanesWithSessions([]);
    expect(getLane(lane.id)?.sessionKey).toBe(lane.sessionKey);
    // Repair historical session loss from the exact job/lane/branch identity.
    detachSession(lane.id, 'system');
    setLaneStatus(lane.id, 'paused', 'system', 'operator_detach');
    reconcileCloudJobLanes();
    expect(getLane(lane.id)?.sessionKey).toBeNull();
    setLaneStatus(lane.id, 'paused', 'system', 'session_lost');
    closeDb();
    reconcileCloudJobLanes();
    expect(getLane(lane.id)).toMatchObject({ status: 'reviewing', sessionKey: lane.sessionKey, worktreePath: null });
    closeDb();
    const reviewed = await (await tasks.GET(request('/api/tasks?includeDone=true'))).json();
    expect(reviewed.tasks.find((task: { id: string }) => task.id === taskId))
      .toMatchObject({ group: 'review', blockedReason: null });
    const reset = await run(await create('gpt-6.1-sol', 'medium'), 'adaptive');
    expect(reset.status).toBe(200);
    expect((await reset.json()).workerRouting.selectedEffort).toBeNull();
    const override = await run(await create('gpt-6.1-sol', 'high'), 'medium');
    expect(override.status).toBe(200);
    expect((await override.json()).workerRouting.selectedEffort).toBe('medium');
    localLaunch.mockRestore();
    revokeCloudWorkerKey(key.record.id);
    expect((await run(await create())).status).toBe(409);
  }, 30_000);
});
