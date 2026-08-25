import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

process.env.O8_DATA_DIR ??= mkdtempSync(path.join(os.tmpdir(), 'o8-thread-project-'));
process.env.CORTEX_IDE_DATA_DIR ??= process.env.O8_DATA_DIR;

const {
  LEGACY_DEFAULT_PROJECT_ID,
  OrchestratorThreadProjectError,
  resolveOrchestratorThreadProjectId,
} = await import('./orchestrator-thread-project');
const { DEFAULT_PROJECT_ID } = await import('@/lib/repos/projects');
const { createProject } = await import('@/lib/projects/store');

describe('orchestrator thread project resolution (#1752)', () => {
  it('keeps the local sentinel in step with the ledger constant', () => {
    // Declared locally so this module does not pull the repo-pool graph.
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
