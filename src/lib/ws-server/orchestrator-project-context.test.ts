import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const priorO8DataDir = process.env.O8_DATA_DIR;
const priorCortexDataDir = process.env.CORTEX_IDE_DATA_DIR;
const priorDbPath = process.env.CORTEX_IDE_DB_PATH;
const fixtureRoot = mkdtempSync(join(tmpdir(), 'o8-orchestrator-project-context-'));
const dataDir = join(fixtureRoot, 'data');
const selectedRepoPath = join(fixtureRoot, 'selected-app');
const selectedSitePath = join(fixtureRoot, 'selected-site');
const otherRepoPath = join(fixtureRoot, 'other-app');
const selectedInstructions = [
  'Use the selected project instructions exactly.',
  '',
  `Long binding guidance: ${'keep-this-guidance-verbatim '.repeat(30)}`,
  'Final binding line after the old 700-character boundary.',
].join('\n');

process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DB_PATH = join(dataDir, 'cortex-ide.db');

interface FixtureModules {
  createProject: typeof import('@/lib/projects/store').createProject;
  addRepoToProject: typeof import('@/lib/projects/store').addRepoToProject;
  setActiveProject: typeof import('@/lib/repos/projects').setActiveProject;
  safeOrchestratorHistoryPath: typeof import('@/lib/mobile/orchestrator-thread-history').safeOrchestratorHistoryPath;
  persistOrchestratorThreadUserMessageFromWire: typeof import('./orchestrator-thread-send').persistOrchestratorThreadUserMessageFromWire;
  prepareOrchestratorProjectTurn: typeof import('./orchestrator-project-context').prepareOrchestratorProjectTurn;
  readPersistedOrchestratorProjectSelection: typeof import('./orchestrator-project-context').readPersistedOrchestratorProjectSelection;
}

let modules: FixtureModules;
let selectedProjectId: string;
let emptyProjectId: string;
let otherProjectId: string;

function repo(id: string, name: string, localPath: string) {
  return {
    id,
    name,
    localPath,
    remoteUrl: null,
    defaultBranch: 'main',
    isGitRepo: true,
    addedAt: '2026-09-22T00:00:00.000Z',
    lastOpenedAt: null,
    storagePressureParkingDisabled: false,
    setup: {
      envMode: 'skip' as const,
      envFiles: [],
      installCommand: null,
      installOnCreateWorkspace: false,
      buildCommand: null,
      runBuildOnCreateWorkspace: false,
      devCommand: null,
      defaultPort: null,
      workspaceIsolationPreference: 'auto' as const,
    },
  };
}

beforeAll(async () => {
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(selectedRepoPath, { recursive: true });
  mkdirSync(selectedSitePath, { recursive: true });
  mkdirSync(otherRepoPath, { recursive: true });
  writeFileSync(join(dataDir, 'repos.json'), JSON.stringify({
    version: 1,
    repos: [
      repo('repo-selected-app', 'Selected App', selectedRepoPath),
      repo('repo-selected-site', 'Selected Site', selectedSitePath),
      repo('repo-other-app', 'Other App', otherRepoPath),
    ],
  }));

  const projectStore = await import('@/lib/projects/store');
  const panelProjects = await import('@/lib/repos/projects');
  const history = await import('@/lib/mobile/orchestrator-thread-history');
  const threadSend = await import('./orchestrator-thread-send');
  const projectContext = await import('./orchestrator-project-context');
  modules = {
    createProject: projectStore.createProject,
    addRepoToProject: projectStore.addRepoToProject,
    setActiveProject: panelProjects.setActiveProject,
    safeOrchestratorHistoryPath: history.safeOrchestratorHistoryPath,
    persistOrchestratorThreadUserMessageFromWire: threadSend.persistOrchestratorThreadUserMessageFromWire,
    prepareOrchestratorProjectTurn: projectContext.prepareOrchestratorProjectTurn,
    readPersistedOrchestratorProjectSelection: projectContext.readPersistedOrchestratorProjectSelection,
  };

  const selected = modules.createProject({
    name: 'Selected Product',
    slug: 'selected-product',
    description: selectedInstructions,
  });
  selectedProjectId = selected.id;
  modules.addRepoToProject(selected.id, 'repo-selected-app', 'fullstack');
  modules.addRepoToProject(selected.id, 'repo-selected-site', 'site');

  const other = modules.createProject({
    name: 'Other Active Product',
    slug: 'other-active-product',
    description: 'This active project must not leak into the selected thread.',
  });
  otherProjectId = other.id;
  modules.addRepoToProject(other.id, 'repo-other-app', 'fullstack');
  await modules.setActiveProject(other.id);

  const empty = modules.createProject({
    name: 'Empty Product',
    slug: 'empty-product',
    description: 'Empty projects still have valid instructions.',
  });
  emptyProjectId = empty.id;
});

afterAll(() => {
  if (priorO8DataDir === undefined) delete process.env.O8_DATA_DIR;
  else process.env.O8_DATA_DIR = priorO8DataDir;
  if (priorCortexDataDir === undefined) delete process.env.CORTEX_IDE_DATA_DIR;
  else process.env.CORTEX_IDE_DATA_DIR = priorCortexDataDir;
  if (priorDbPath === undefined) delete process.env.CORTEX_IDE_DB_PATH;
  else process.env.CORTEX_IDE_DB_PATH = priorDbPath;
  rmSync(fixtureRoot, { recursive: true, force: true });
});

describe('orchestrator project turn preparation', () => {
  it('uses the persisted selected project across both repos while another project is active', async () => {
    const threadId = 'thoughts-selected-project';
    const original = '## Project Brief\nOperator-authored heading that must stay in the task.';
    const persistedThread = modules.persistOrchestratorThreadUserMessageFromWire({
      message: { projectId: selectedProjectId },
      tabId: threadId,
      repoPath: selectedRepoPath,
      transcriptMessage: original,
      messageId: 'user-selected-project',
      backend: 'codex',
      timestampMs: Date.now(),
    });

    const selection = await modules.readPersistedOrchestratorProjectSelection(threadId);
    const prepared = await modules.prepareOrchestratorProjectTurn({
      message: original,
      persistedProjectId: persistedThread?.projectId,
      repoPath: persistedThread?.repoPath,
    });
    const persisted = JSON.parse(
      readFileSync(modules.safeOrchestratorHistoryPath(threadId), 'utf8'),
    ) as { messages: Array<{ content: string }> };

    expect(selection).toEqual({ projectId: selectedProjectId, repoPath: selectedRepoPath });
    expect(persisted.messages).toEqual([expect.objectContaining({ content: original })]);
    expect(prepared.projectContext).toMatchObject({
      id: selectedProjectId,
      runtimeProjectId: selectedProjectId,
      panelProjectId: selectedProjectId,
      settingsProjectId: selectedProjectId,
      name: 'Selected Product',
    });
    expect(prepared.projectContext?.instructions).toBe(selectedInstructions);
    expect(prepared.message).toContain(`Project instructions:\n${selectedInstructions}`);
    expect(prepared.message).toContain('Selected App');
    expect(prepared.message).toContain('Selected Site');
    expect(prepared.message).not.toContain('Other Active Product');
    expect(prepared.message).not.toContain('This active project must not leak');
    expect(prepared.message.slice(0, prepared.message.indexOf('## Task')).match(/^## Project Brief$/gm)).toHaveLength(1);
    expect(prepared.message.endsWith(`## Task\n\n${original}`)).toBe(true);
  });

  it('keeps an empty explicit project separate and rejects an unknown identity', async () => {
    const prepared = await modules.prepareOrchestratorProjectTurn({
      message: 'Plan this empty project.',
      requestedProjectId: emptyProjectId,
      repoPath: otherRepoPath,
    });

    expect(prepared.projectContext).toMatchObject({
      id: emptyProjectId,
      runtimeProjectId: emptyProjectId,
      settingsProjectId: emptyProjectId,
      repoPaths: [],
      repos: [],
      currentRepo: null,
      repoInProject: false,
    });
    expect(prepared.message).toContain('Project instructions:\nEmpty projects still have valid instructions.');
    expect(prepared.message).not.toContain('Other App');
    await expect(modules.prepareOrchestratorProjectTurn({
      message: 'Do not mix this turn.',
      requestedProjectId: 'missing-project',
      repoPath: otherRepoPath,
    })).rejects.toThrow('Project missing-project does not exist.');
  });

  it('uses a valid wire project when persisted thread metadata is unreadable', async () => {
    const threadId = 'thoughts-corrupt-project';
    mkdirSync(join(dataDir, 'chat-history'), { recursive: true });
    writeFileSync(modules.safeOrchestratorHistoryPath(threadId), '{not-json');
    const selection = await modules.readPersistedOrchestratorProjectSelection(threadId);
    const prepared = await modules.prepareOrchestratorProjectTurn({
      message: 'Use the explicit selected project.',
      persistedProjectId: selection?.projectId,
      requestedProjectId: selectedProjectId,
      repoPath: selection?.repoPath ?? selectedRepoPath,
    });

    expect(selection).toBeNull();
    expect(prepared.projectContext?.id).toBe(selectedProjectId);
    expect(prepared.message).toContain(`Project instructions:\n${selectedInstructions}`);
  });

  it('rejects a wire project that conflicts with the persisted thread project', async () => {
    await expect(modules.prepareOrchestratorProjectTurn({
      message: 'Do not cross project boundaries.',
      persistedProjectId: selectedProjectId,
      requestedProjectId: otherProjectId,
      repoPath: selectedRepoPath,
    })).rejects.toMatchObject({
      code: 'orchestrator_thread_project_mismatch',
      projectId: otherProjectId,
      existingProjectId: selectedProjectId,
    });
  });
});
