import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, expect, it, vi } from 'vitest';

const dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'o8-scope-orphan-project-')));
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;

vi.mock('@/lib/runtime/registry', () => ({
  getRuntimeProcessForWorktree: vi.fn(async () => null),
}));
vi.mock('@/lib/push/notify', () => ({ notifyApprovalCreated: vi.fn() }));

const scopeRoute = await import('@/app/api/lanes/[id]/scope/route');
const locksRoute = await import('@/app/api/projects/locks/route');
const taskRoute = await import('@/app/api/tasks/[taskId]/route');
const { createLane, getLane } = await import('@/lib/lane/registry');
const { createApproval, getApproval } = await import('@/lib/approvals/store');
const { createProject, addRepoToProject } = await import('@/lib/projects/store');
const { addRepo } = await import('@/lib/repos/registry');
const projectContext = await import('@/lib/projects/context');
const { listProjectLocks } = await import('@/lib/projects/locks');
const { writeOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const { closeDb, getSqlite } = await import('@/lib/db');
const { getOrCreateWsToken } = await import('@/lib/ws-auth');
const { mintPacketWorkerToken } = await import('@/lib/auth/packet-worker-token');

function request(path: string, bearer = getOrCreateWsToken()) {
  return new NextRequest(`http://localhost${path}`, {
    headers: { host: 'localhost', authorization: `Bearer ${bearer}` },
  });
}

afterAll(() => {
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

it('returns a valid packet scope with orphaned lanes and approvals persisted', async () => {
  const repoPath = join(dataDir, 'repo');
  mkdirSync(repoPath);
  execFileSync('git', ['init', '-q', '-b', 'main', repoPath]);
  writeFileSync(join(repoPath, 'fixture.txt'), 'scope fixture\n');
  execFileSync('git', ['add', 'fixture.txt'], { cwd: repoPath });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.test',
    'commit', '-qm', 'fixture'], { cwd: repoPath });
  const repo = await addRepo(repoPath);
  const project = createProject({ name: 'Valid scope project' });
  addRepoToProject(project.id, repo.id, 'fullstack', 'manual');
  const packetId = 'pkt-valid-orphan-scope';
  const lane = createLane({ repoPath, projectId: project.id, packetId,
    branch: 'test/valid-scope', runtime: 'codex' });
  const missingProjectId = 'proj-deleted-scope';
  const orphan = createLane({ repoPath, projectId: missingProjectId,
    branch: 'test/orphan-scope', runtime: 'codex' });
  const approval = createApproval({
    projectId: missingProjectId, source: 'test', runtime: 'codex', agent: 'Test',
    sessionKey: 'codex:orphan-scope', title: 'Historical approval',
    description: 'Approval for a missing project', summary: 'Orphan fixture', risk: 'low',
    metadata: { laneId: orphan.id },
  });
  writeOrchestratorControlPlaneState({
    ...createEmptyOrchestratorMissionState(), missionId: 'mission-orphan-scope', repoPath,
    packets: [{
      id: packetId, referenceLabel: 'scope', title: 'Read valid scope', summary: 'Read scope',
      projectId: project.id, workspaceTargetPath: repoPath, branchTarget: lane.branch,
      runtime: 'codex', dependencyLabels: [], dependencyPacketIds: [],
      queueState: 'queued', releaseState: 'pending', status: 'running', lane: null,
      allowedFiles: ['fixture.txt'],
    }],
  });
  // Reopen persistence so the route cannot pass using only in-memory fixtures.
  closeDb();
  expect(getSqlite().prepare('SELECT id FROM projects WHERE id = ?').get(missingProjectId)).toBeUndefined();
  expect(getLane(orphan.id)?.projectId).toBe(missingProjectId);
  expect(getApproval(approval.id)?.projectId).toBe(missingProjectId);

  const bearer = mintPacketWorkerToken(packetId);
  for (const id of [lane.id, packetId]) {
    const response = await scopeRoute.GET(request(`/api/lanes/${id}/scope`, bearer), {
      params: Promise.resolve({ id }),
    });
    expect(response.status).toBe(200);
    const scope = await response.json();
    expect(scope).toMatchObject({ packetId, laneId: lane.id, allowedPaths: ['fixture.txt'],
      project: { id: project.id, currentRepo: { id: repo.id } } });
    expect(scope.project.locks.map((lock: { laneId: string }) => lock.laneId)).toEqual([lane.id]);
  }
  for (const query of ['', `?projectId=${project.id}`]) {
    const response = await locksRoute.GET(request(`/api/projects/locks${query}`));
    expect(response.status).toBe(200);
    expect((await response.json()).locks.map((lock: { laneId: string }) => lock.laneId)).toEqual([lane.id]);
  }
  const task = await taskRoute.GET(request(`/api/tasks/${packetId}`), {
    params: Promise.resolve({ taskId: packetId }),
  });
  expect(task.status).toBe(200);
  expect((await task.json()).task).toMatchObject({ id: packetId, project: { id: project.id } });
  expect(getLane(orphan.id)?.projectId).toBe(missingProjectId);
  expect(getApproval(approval.id)?.projectId).toBe(missingProjectId);
  await expect(projectContext.getProjectContext({ projectId: missingProjectId }))
    .rejects.toBeInstanceOf(projectContext.ProjectNotFoundError);
});

it('does not suppress unexpected project-resolution failures', async () => {
  createLane({ repoPath: join(dataDir, 'error-repo'), projectId: 'proj-error-scope',
    branch: 'test/error-scope', runtime: 'codex', baseCommit: 'a'.repeat(40) });
  const failure = new Error('Project storage unavailable');
  const resolve = vi.spyOn(projectContext, 'getProjectContext').mockRejectedValueOnce(failure);
  try {
    await expect(listProjectLocks()).rejects.toBe(failure);
  } finally {
    resolve.mockRestore();
  }
});
