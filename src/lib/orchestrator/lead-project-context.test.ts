import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const backendPrompts = vi.hoisted(() => [] as string[]);
vi.mock('@/lib/lane/orchestrator-send-entry', () => ({
  sendOrchestratorBackendTurn: vi.fn(async (
    _backend: unknown,
    _repoPath: string,
    message: string,
    onEvent: (event: Record<string, unknown>) => void,
  ) => {
    backendPrompts.push(message);
    onEvent({ type: 'text', text: 'fixture response' });
    onEvent({ type: 'done', sessionId: 'fixture-lead-session' });
  }),
}));
vi.mock('@/lib/orchestrator/control-plane', () => ({
  readOrchestratorControlPlaneState: () => ({ packets: [] }),
}));
vi.mock('@/lib/orchestrator/mission-registry', () => ({
  listMissionRegistryEntries: () => [],
}));

const priorO8DataDir = process.env.O8_DATA_DIR;
const priorCortexDataDir = process.env.CORTEX_IDE_DATA_DIR;
const priorDbPath = process.env.CORTEX_IDE_DB_PATH;
const fixtureRoot = mkdtempSync(join(tmpdir(), 'o8-lead-project-context-'));
const dataDir = join(fixtureRoot, 'data');
const primaryRepoPath = join(fixtureRoot, 'product-app');
const siblingRepoPath = join(fixtureRoot, 'product-site');

process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DB_PATH = join(dataDir, 'cortex-ide.db');

interface LoadedModules {
  addRepoToProject: typeof import('@/lib/projects/store').addRepoToProject;
  closeDb: typeof import('@/lib/db').closeDb;
  createProject: typeof import('@/lib/projects/store').createProject;
  getSqlite: typeof import('@/lib/db').getSqlite;
  getLeadStatus: typeof import('./lead-lifecycle').getLeadStatus;
  safeOrchestratorHistoryPath: typeof import('@/lib/mobile/orchestrator-thread-history').safeOrchestratorHistoryPath;
  sendLeadThreadMessage: typeof import('./lead-lifecycle').sendLeadThreadMessage;
  startLead: typeof import('./lead-lifecycle').startLead;
  updateProject: typeof import('@/lib/projects/store').updateProject;
}

let loaded: LoadedModules;
let selectedProjectId: string;

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
  mkdirSync(primaryRepoPath, { recursive: true });
  mkdirSync(siblingRepoPath, { recursive: true });
  for (const repoPath of [primaryRepoPath, siblingRepoPath]) {
    execFileSync('git', ['init', '-q', '-b', 'main', repoPath]);
    writeFileSync(join(repoPath, 'README.md'), `# ${repoPath === primaryRepoPath ? 'Product App' : 'Product Site'}\n`);
    execFileSync('git', ['-C', repoPath, 'add', 'README.md']);
    execFileSync('git', [
      '-C', repoPath,
      '-c', 'user.name=o8 test',
      '-c', 'user.email=test@o8.local',
      'commit', '-qm', 'test: seed project context fixture',
    ]);
  }
  writeFileSync(join(dataDir, 'repos.json'), JSON.stringify({
    version: 1,
    repos: [
      repo('repo-product-app', 'Product App', primaryRepoPath),
      repo('repo-product-site', 'Product Site', siblingRepoPath),
    ],
  }));

  const db = await import('@/lib/db');
  const projects = await import('@/lib/projects/store');
  const history = await import('@/lib/mobile/orchestrator-thread-history');
  const lifecycle = await import('./lead-lifecycle');
  loaded = {
    addRepoToProject: projects.addRepoToProject,
    closeDb: db.closeDb,
    createProject: projects.createProject,
    getSqlite: db.getSqlite,
    getLeadStatus: lifecycle.getLeadStatus,
    safeOrchestratorHistoryPath: history.safeOrchestratorHistoryPath,
    sendLeadThreadMessage: lifecycle.sendLeadThreadMessage,
    startLead: lifecycle.startLead,
    updateProject: projects.updateProject,
  };

  const project = loaded.createProject({
    name: 'Lead Product',
    slug: 'lead-product',
    description: 'Initial binding guidance.',
  });
  selectedProjectId = project.id;
  loaded.addRepoToProject(project.id, 'repo-product-app', 'fullstack');
  loaded.addRepoToProject(project.id, 'repo-product-site', 'site');
});

afterAll(() => {
  loaded.closeDb();
  if (priorO8DataDir === undefined) delete process.env.O8_DATA_DIR;
  else process.env.O8_DATA_DIR = priorO8DataDir;
  if (priorCortexDataDir === undefined) delete process.env.CORTEX_IDE_DATA_DIR;
  else process.env.CORTEX_IDE_DATA_DIR = priorCortexDataDir;
  if (priorDbPath === undefined) delete process.env.CORTEX_IDE_DB_PATH;
  else process.env.CORTEX_IDE_DB_PATH = priorDbPath;
  rmSync(fixtureRoot, { recursive: true, force: true });
});

describe('persistent lead project context', () => {
  it('binds a missing thread project before execution and replays raw admission after instructions change', async () => {
    const started = loaded.startLead({
      repoPath: primaryRepoPath,
      backend: 'codex',
      model: 'gpt-5.6-sol',
      effort: 'high',
      idempotencyKey: 'lead-project-start',
      brief: {
        objective: 'Create the persistent lead fixture.',
        scope: ['fixture'],
        doneTests: ['captured prompt'],
        nonGoals: [],
        budgets: [],
        escalationCriteria: ['fixture failure'],
      },
    });
    await vi.waitFor(() => expect(backendPrompts).toHaveLength(1));
    rmSync(loaded.safeOrchestratorHistoryPath(started.lead.threadId), { force: true });

    const original = 'Keep this exact operator message.';
    const admitted = await loaded.sendLeadThreadMessage({
      threadId: started.lead.threadId,
      repoPath: primaryRepoPath,
      projectId: selectedProjectId,
      message: original,
      displayMessage: original,
      idempotencyKey: 'lead-project-turn',
      backend: 'codex',
      model: 'gpt-5.6-sol',
      effort: 'high',
    });
    expect(admitted?.duplicate).toBe(false);
    await vi.waitFor(() => expect(backendPrompts).toHaveLength(2));

    const modelPrompt = backendPrompts[1];
    expect(modelPrompt).toContain('Project instructions:\nInitial binding guidance.');
    expect(modelPrompt).toContain('Product App');
    expect(modelPrompt).toContain('Product Site');
    expect(modelPrompt).toContain(original);
    const record = JSON.parse(
      readFileSync(loaded.safeOrchestratorHistoryPath(started.lead.threadId), 'utf8'),
    ) as { projectId: string; messages: Array<{ role: string; content: string }> };
    expect(record.projectId).toBe(selectedProjectId);
    expect(record.messages.filter((message) => message.role === 'user'))
      .toEqual([expect.objectContaining({ content: original })]);

    loaded.updateProject(selectedProjectId, { description: 'Changed after the first admission.' });
    const replayed = await loaded.sendLeadThreadMessage({
      threadId: started.lead.threadId,
      repoPath: primaryRepoPath,
      projectId: selectedProjectId,
      message: original,
      displayMessage: original,
      idempotencyKey: 'lead-project-turn',
      backend: 'codex',
      model: 'gpt-5.6-sol',
      effort: 'high',
    });
    expect(replayed?.duplicate).toBe(true);
    expect(replayed?.admittedTurnId).toBe(admitted?.admittedTurnId);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(backendPrompts).toHaveLength(2);
    expect(loaded.getSqlite().prepare(
      'SELECT message FROM orchestrator_lead_turns WHERE id = ?',
    ).get(admitted?.admittedTurnId)).toEqual({ message: original });
    expect(loaded.getLeadStatus(started.lead.id).latestTurn?.id).toBe(admitted?.admittedTurnId);
  });
});
