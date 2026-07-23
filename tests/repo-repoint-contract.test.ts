import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const previousHome = process.env.HOME;
const previousDataDir = process.env.CORTEX_IDE_DATA_DIR;
const previousO8DataDir = process.env.O8_DATA_DIR;
const home = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'o8-repoint-home-')));
const dataDir = path.join(home, '.o8-data');
process.env.HOME = home;
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_DATA_DIR = dataDir;
mkdirSync(dataDir, { recursive: true });

const reposRoute = await import('@/app/api/panel/repos/route');
const { createLane, getLane } = await import('@/lib/lane/registry');
const { getSqlite } = await import('@/lib/db');
const { buildRepoStateScope } = await import('@/lib/terminal/tab-state');
const { writePersistedLlmChat, readPersistedLlmChat } = await import('@/lib/llm/chat-history-store');

afterAll(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousDataDir === undefined) delete process.env.CORTEX_IDE_DATA_DIR;
  else process.env.CORTEX_IDE_DATA_DIR = previousDataDir;
  if (previousO8DataDir === undefined) delete process.env.O8_DATA_DIR;
  else process.env.O8_DATA_DIR = previousO8DataDir;
});

function initRepo(repoPath: string) {
  mkdirSync(repoPath, { recursive: true });
  execFileSync('git', ['init', '-q', '--initial-branch=main'], { cwd: repoPath });
}

async function post(body: unknown) {
  return reposRoute.POST(new Request('http://127.0.0.1/api/panel/repos', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

describe('repo re-point contract (#1581)', () => {
  it('updates a registered Git repo in place and migrates its path-keyed associations', async () => {
    const previousPath = path.join(home, 'before-move');
    const nextPath = path.join(home, 'after-move');
    initRepo(previousPath);

    const registered = await post({ action: 'add', localPath: previousPath });
    const registeredData = await registered.json() as { repo?: { id: string; localPath: string } };
    expect(registered.status).toBe(201);
    const repo = registeredData.repo!;

    writeFileSync(path.join(dataDir, 'projects.json'), JSON.stringify({
      projects: [{ id: 'project-repoint', name: 'Moved repo', repoPaths: [repo.localPath], createdAt: new Date().toISOString() }],
      activeProjectId: 'project-repoint',
    }));
    const lane = createLane({
      repoPath: repo.localPath,
      worktreePath: path.join(repo.localPath, '.cortex-worktrees', 'packet-repoint'),
      branch: 'main',
      runtime: 'codex',
    });
    getSqlite().prepare(`
      INSERT INTO docs (id, repo_path, repo_name, rel_path, kind, title, body, size_bytes, last_modified, last_synced)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      `${repo.localPath}:README.md`, repo.localPath, 'before-move', 'README.md', 'readme', 'Before', 'Before move', 11,
      new Date().toISOString(), new Date().toISOString(),
    );
    getSqlite().prepare(`
      INSERT INTO facts_queue (id, source_kind, source_id, repo_path, enqueued_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      'queued-repoint-fact', 'doc', `doc:${repo.localPath}:README.md`, repo.localPath, new Date().toISOString(),
    );
    const terminalStateDir = path.join(home, '.o8', 'terminal-states');
    mkdirSync(terminalStateDir, { recursive: true });
    writeFileSync(path.join(terminalStateDir, `${buildRepoStateScope(repo.localPath)}.json`), JSON.stringify({
      activeTabId: 'terminal-repoint',
      tabs: [{ id: 'terminal-repoint', repoPath: repo.localPath }],
    }));
    writePersistedLlmChat('thoughts-repoint', {
      messages: [],
      repoPath: repo.localPath,
      repoName: 'before-move',
    });
    writeFileSync(path.join(dataDir, 'external-merge-state.json'), JSON.stringify({
      version: 1,
      cursors: { [repo.localPath]: 'cursor-before-move' },
    }));

    renameSync(previousPath, nextPath);
    const repointed = await post({ action: 'update', id: repo.id, localPath: nextPath });
    const repointedData = await repointed.json() as { error?: string; repo?: { id: string; localPath: string } };

    expect(repointed.status, repointedData.error).toBe(200);
    expect(repointedData.repo).toMatchObject({ id: repo.id, localPath: nextPath });

    const registry = JSON.parse(readFileSync(path.join(dataDir, 'repos.json'), 'utf8')) as { repos: Array<{ id: string; localPath: string }> };
    expect(registry.repos).toContainEqual(expect.objectContaining({ id: repo.id, localPath: nextPath }));

    const ledger = JSON.parse(readFileSync(path.join(dataDir, 'projects.json'), 'utf8')) as { projects: Array<{ repoPaths: string[] }> };
    expect(ledger.projects[0]?.repoPaths).toEqual([nextPath]);
    expect(getLane(lane.id)).toMatchObject({
      repoPath: nextPath,
      worktreePath: path.join(nextPath, '.cortex-worktrees', 'packet-repoint'),
    });
    expect(getSqlite().prepare('SELECT id, repo_path FROM docs WHERE rel_path = ?').get('README.md')).toEqual({
      id: `${nextPath}:README.md`,
      repo_path: nextPath,
    });
    expect(getSqlite().prepare('SELECT source_id, repo_path FROM facts_queue WHERE id = ?').get('queued-repoint-fact')).toEqual({
      source_id: `doc:${nextPath}:README.md`,
      repo_path: nextPath,
    });
    expect(existsSync(path.join(terminalStateDir, `${buildRepoStateScope(nextPath)}.json`))).toBe(true);
    expect(existsSync(path.join(terminalStateDir, `${buildRepoStateScope(repo.localPath)}.json`))).toBe(false);
    expect(readPersistedLlmChat('thoughts-repoint')?.history.repoPath).toBe(nextPath);
    const externalMergeState = JSON.parse(readFileSync(path.join(dataDir, 'external-merge-state.json'), 'utf8')) as { cursors: Record<string, string> };
    expect(externalMergeState.cursors).toEqual({ [nextPath]: 'cursor-before-move' });
  });
});
