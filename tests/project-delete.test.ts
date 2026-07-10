/**
 * Real-path tests for project deletion (the "can't delete projects" class).
 *
 * Driven through the ACTUAL route handlers against persisted state, per the
 * reachability doctrine — the original bug was invisible to lib-level tests
 * because the resurrection happens in the read-time projection, not the
 * delete call.
 *
 * Semantics under test (operator ruling 2026-07-09): deleting a project also
 * removes its EXCLUSIVE repos from o8's pool (repos on disk untouched), so
 * nothing re-projects as a same-named virtual single-repo row. Deleting a
 * virtual `repo:<id>` row removes the repo — never a silent 200 no-op.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { NextRequest } from 'next/server';
import { afterAll, describe, expect, it } from 'vitest';

const home = mkdtempSync(join(os.tmpdir(), 'o8-project-delete-home-'));
const dataDir = join(home, '.o8');
mkdirSync(dataDir, { recursive: true });
const WS_TOKEN = 'project-delete-test-token-0123456789abcdef';
writeFileSync(join(dataDir, 'ws-token'), `${WS_TOKEN}\n`, 'utf-8');
process.env.HOME = home;
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;

const panelProjectsRoute = await import('@/app/api/panel/projects/route');
const panelProjectRoute = await import('@/app/api/panel/projects/[id]/route');
const settingsProjectRoute = await import('@/app/api/projects/[id]/route');
const { addRepo, listRepos } = await import('@/lib/repos/registry');
const { getProjectsLedger, setProjectRepos } = await import('@/lib/repos/projects');
const { createProject: createSqliteProject, addRepoToProject } = await import('@/lib/projects/store');

function makeGitRepo(name: string): string {
  const repoPath = mkdtempSync(join(os.tmpdir(), `o8-project-delete-${name}-`));
  execFileSync('git', ['init', '-q', repoPath]);
  return repoPath;
}

function del(url: string) {
  return new NextRequest(url, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${WS_TOKEN}` },
  });
}

async function createPanelProject(name: string): Promise<string> {
  const res = await panelProjectsRoute.POST(
    new NextRequest('http://127.0.0.1:3001/api/panel/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${WS_TOKEN}` },
      body: JSON.stringify({ name }),
    }),
  );
  expect(res.status).toBe(200);
  const ledger = await getProjectsLedger();
  const project = ledger.projects.find((p) => p.name === name);
  expect(project).toBeTruthy();
  return project!.id;
}

async function deleteViaPanel(id: string) {
  return panelProjectRoute.DELETE(
    del(`http://127.0.0.1:3001/api/panel/projects/${encodeURIComponent(id)}`),
    { params: Promise.resolve({ id }) },
  );
}

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('project delete removes exclusive repos (no resurrection)', () => {
  it('deleting a real project removes it AND its exclusive repo from the pool', async () => {
    const repoPath = makeGitRepo('solo');
    const repo = await addRepo(repoPath);
    // A second project keeps the SQLite enrichment path live after the delete —
    // the exact shape where the old code resurrected the repo as a virtual row.
    await createPanelProject('bystander');
    const projectId = await createPanelProject('doomed');
    await setProjectRepos(projectId, [repo.localPath]);

    const res = await deleteViaPanel(projectId);
    expect(res.status).toBe(200);

    const after = await getProjectsLedger();
    expect(after.projects.find((p) => p.id === projectId)).toBeUndefined();
    // No same-named virtual resurrection:
    expect(after.projects.find((p) => p.id === `repo:${repo.id}`)).toBeUndefined();
    // Repo gone from the pool:
    expect((await listRepos()).find((r) => r.id === repo.id)).toBeUndefined();
  });

  it('deleting a virtual repo: row removes the repo instead of silently no-oping', async () => {
    const repoPath = makeGitRepo('virt');
    const repo = await addRepo(repoPath);
    // Unassigned repo + a live SQLite project → repo projects as a virtual row.
    const before = await getProjectsLedger();
    const virtual = before.projects.find((p) => p.id === `repo:${repo.id}`);
    expect(virtual).toBeTruthy();

    const res = await deleteViaPanel(virtual!.id);
    expect(res.status).toBe(200);

    const after = await getProjectsLedger();
    expect(after.projects.find((p) => p.id === virtual!.id)).toBeUndefined();
    expect((await listRepos()).find((r) => r.id === repo.id)).toBeUndefined();
  });

  it('a repo shared with a surviving project stays in the pool', async () => {
    const repoPath = makeGitRepo('shared');
    const repo = await addRepo(repoPath);
    const keepId = await createPanelProject('keeper');
    const dropId = await createPanelProject('dropper');
    await setProjectRepos(keepId, [repo.localPath]);
    await setProjectRepos(dropId, [repo.localPath]);

    const res = await deleteViaPanel(dropId);
    expect(res.status).toBe(200);

    expect((await listRepos()).find((r) => r.id === repo.id)).toBeTruthy();
    const after = await getProjectsLedger();
    const keeper = after.projects.find((p) => p.id === keepId);
    expect(keeper?.repoPaths).toContain(repo.localPath);
  });

  it('settings route (/api/projects/[id]) with a raw SQLite id gets the same semantics', async () => {
    const repoPath = makeGitRepo('settings');
    const repo = await addRepo(repoPath);
    const sqliteProject = createSqliteProject({ name: 'settings-born', slug: 'settings-born', description: null });
    addRepoToProject(sqliteProject.id, repo.id, null, 'manual');

    const res = await settingsProjectRoute.DELETE(
      del(`http://127.0.0.1:3001/api/projects/${encodeURIComponent(sqliteProject.id)}`),
      { params: Promise.resolve({ id: sqliteProject.id }) },
    );
    expect(res.status).toBe(200);

    const after = await getProjectsLedger();
    expect(after.projects.find((p) => p.name === 'settings-born')).toBeUndefined();
    expect(after.projects.find((p) => p.id === `repo:${repo.id}`)).toBeUndefined();
    expect((await listRepos()).find((r) => r.id === repo.id)).toBeUndefined();
  });
});
