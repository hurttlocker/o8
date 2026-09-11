import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

process.env.O8_DATA_DIR ??= mkdtempSync(path.join(os.tmpdir(), 'o8-thread-project-'));
process.env.CORTEX_IDE_DATA_DIR ??= process.env.O8_DATA_DIR;

/**
 * A repo in the pool that belongs to no project — the state every repo is in
 * right after it is registered, and the one the ledger projects a virtual
 * `repo:<id>` project for. Written before the registry module loads so the
 * first read sees it (#2140).
 */
const POOL_REPO_ID = 'fbf8cf7b-280e-40d6-8599-c9adb57d3172';
writeFileSync(
  path.join(process.env.O8_DATA_DIR, 'repos.json'),
  JSON.stringify({
    version: 1,
    repos: [{
      id: POOL_REPO_ID,
      name: 'solo-repo',
      localPath: path.join(process.env.O8_DATA_DIR, 'solo-repo'),
      remoteUrl: null,
      defaultBranch: 'main',
      addedAt: new Date().toISOString(),
      lastOpenedAt: null,
    }],
  }),
  'utf8',
);

const {
  LEGACY_DEFAULT_PROJECT_ID,
  OrchestratorThreadProjectError,
  resolveOrchestratorThreadProjectId,
} = await import('./orchestrator-thread-project');
const { DEFAULT_PROJECT_ID } = await import('@/lib/repos/projects');
const { virtualRepoProjectId } = await import('@/lib/repos/virtual-project-id');
const { createProject } = await import('@/lib/projects/store');

describe('orchestrator thread project resolution (#1752)', () => {
  it('keeps the local sentinel in step with the ledger constant', () => {
    // Declared locally rather than imported from the ledger module.
    expect(LEGACY_DEFAULT_PROJECT_ID).toBe(DEFAULT_PROJECT_ID);
  });

  it('resolves the legacy sentinel to no-project instead of failing the turn', () => {
    // On a fresh install SQLite has no 'default' row, so every orchestrator
    // turn failed with "Project default does not exist" — before the operator
    // had registered a repo, which is the first thing they do.
    expect(resolveOrchestratorThreadProjectId(null, LEGACY_DEFAULT_PROJECT_ID)).toBeNull();
  });

  it('resolves a thread already stamped with the sentinel', () => {
    // Threads persisted before a repo was registered carry it too, and kept
    // failing even after the operator fixed their setup.
    expect(resolveOrchestratorThreadProjectId(LEGACY_DEFAULT_PROJECT_ID, null)).toBeNull();
    expect(resolveOrchestratorThreadProjectId(LEGACY_DEFAULT_PROJECT_ID, undefined)).toBeNull();
  });

  it('still refuses an unknown project id that is not the sentinel', () => {
    expect(() => resolveOrchestratorThreadProjectId(null, 'proj-does-not-exist'))
      .toThrow(OrchestratorThreadProjectError);
  });

  it('refuses a stale unknown project id already persisted on the thread', () => {
    expect(() => resolveOrchestratorThreadProjectId('proj-does-not-exist', undefined))
      .toThrow(OrchestratorThreadProjectError);
  });

  it('resolves a real SQLite project normally', () => {
    const project = createProject({ name: 'Real Project' });
    expect(resolveOrchestratorThreadProjectId(null, project.id)).toBe(project.id);
    expect(resolveOrchestratorThreadProjectId(project.id, project.id)).toBe(project.id);
  });

  it('still reports a genuine mismatch between two real projects', () => {
    const a = createProject({ name: 'Project A' });
    const b = createProject({ name: 'Project B' });
    expect(() => resolveOrchestratorThreadProjectId(a.id, b.id)).toThrow(OrchestratorThreadProjectError);
  });

  it('leaves a no-project thread alone', () => {
    expect(resolveOrchestratorThreadProjectId(null, null)).toBeNull();
  });
});

describe('virtual single-repo project resolution (#2140)', () => {
  it('resolves the virtual project the ledger projects for a pool repo', () => {
    // The composer stamps `repo:<id>` onto the thread for a repo that is in no
    // project. SQLite has no such row, so every turn on it — parallel dispatch
    // included — died with "Project repo:<id> does not exist".
    const projectId = virtualRepoProjectId(POOL_REPO_ID);
    expect(resolveOrchestratorThreadProjectId(null, projectId)).toBe(projectId);
  });

  it('resolves a thread already stamped with a virtual project id', () => {
    const projectId = virtualRepoProjectId(POOL_REPO_ID);
    expect(resolveOrchestratorThreadProjectId(projectId, undefined)).toBe(projectId);
    expect(resolveOrchestratorThreadProjectId(projectId, projectId)).toBe(projectId);
  });

  it('still refuses a virtual id whose repo is not in the pool', () => {
    expect(() => resolveOrchestratorThreadProjectId(null, virtualRepoProjectId('not-a-pool-repo')))
      .toThrow(OrchestratorThreadProjectError);
  });

  it('names the repo rather than the internal id when a virtual id fails', () => {
    expect(() => resolveOrchestratorThreadProjectId(null, virtualRepoProjectId('not-a-pool-repo')))
      .toThrow('Repo not-a-pool-repo is not registered.');
  });

  it('still reports a mismatch between a virtual project and a real one', () => {
    const real = createProject({ name: 'Mismatch Project' });
    expect(() => resolveOrchestratorThreadProjectId(virtualRepoProjectId(POOL_REPO_ID), real.id))
      .toThrow(OrchestratorThreadProjectError);
  });
});
