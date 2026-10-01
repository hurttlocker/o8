import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, expect, it } from 'vitest';

const dataDir = mkdtempSync(join(tmpdir(), 'o8-task-pool-history-'));
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;
const route = await import('@/app/api/tasks/route');
const { createLane, getLane } = await import('@/lib/lane/registry');
const { createProject, deleteProject } = await import('@/lib/projects/store');
const { getProjectContext, ProjectNotFoundError } = await import('@/lib/projects/context');
const { closeDb } = await import('@/lib/db');
const { getOrCreateWsToken } = await import('@/lib/ws-auth');
function request(projectId?: string) {
  return new NextRequest(`http://localhost/api/tasks?includeDone=true${projectId ? `&projectId=${encodeURIComponent(projectId)}` : ''}`, {
    headers: { Authorization: `Bearer ${getOrCreateWsToken()}` },
  });
}
afterAll(() => { closeDb(); rmSync(dataDir, { recursive: true, force: true }); });

it('retains orphaned history without retargeting it or blocking scoped tasks', async () => {
  const removed = createProject({ name: 'Historical project' });
  const current = createProject({ name: 'Current project' });
  const lane = createLane({ repoPath: join(dataDir, 'repo'), projectId: removed.id, branch: 'test/history', runtime: 'codex', baseCommit: 'a'.repeat(40) });
  expect(deleteProject(removed.id)).toBe(true);
  closeDb();
  const response = await route.GET(request());
  expect(response.status).toBe(200);
  const pool = await response.json();
  expect(pool.tasks.find((task: { id: string }) => task.id === lane.id)).toMatchObject({ project: null, repoPath: lane.repoPath });
  expect(getLane(lane.id)?.projectId).toBe(removed.id);
  const scoped = await route.GET(request(current.id));
  expect(scoped.status).toBe(200);
  expect((await scoped.json()).tasks).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: lane.id })]));
  await expect(getProjectContext({ projectId: removed.id })).rejects.toBeInstanceOf(ProjectNotFoundError);
  const rejected = await route.POST(new NextRequest('http://localhost/api/tasks', {
    method: 'POST', headers: { Authorization: `Bearer ${getOrCreateWsToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Invalid scope', projectId: removed.id, repoPath: lane.repoPath }),
  }));
  expect(rejected.status).toBeGreaterThanOrEqual(400);
});
