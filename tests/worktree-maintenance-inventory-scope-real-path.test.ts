import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, describe, expect, it } from 'vitest';

const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'o8-maintenance-scope-')));
const priorEnv = {
  O8_DATA_DIR: process.env.O8_DATA_DIR,
  CORTEX_IDE_DATA_DIR: process.env.CORTEX_IDE_DATA_DIR,
  O8_WORKTREE_ROOT: process.env.O8_WORKTREE_ROOT,
};
process.env.O8_DATA_DIR = path.join(root, 'data');
process.env.CORTEX_IDE_DATA_DIR = process.env.O8_DATA_DIR;
process.env.O8_WORKTREE_ROOT = path.join(root, 'workspaces');
const repoA = path.join(root, 'repo-a');
const repoB = path.join(root, 'repo-a-sibling');
const alias = path.join(root, 'repo-alias');
mkdirSync(repoA);
mkdirSync(repoB);
symlinkSync(repoA, alias, 'dir');

const { closeDb, getSqlite } = await import('@/lib/db');
const { GET } = await import('@/app/api/orchestrator/workspace/maintenance/route');
const { registerMaintenanceRoot, holdMaintenanceRoot, writeMaintenanceState } = await import('@/lib/worktree/maintenance-discovery');
const { getOrCreateWsToken } = await import('@/lib/ws-auth');
const { mintPacketWorkerToken } = await import('@/lib/auth/packet-worker-token');
const token = getOrCreateWsToken();
const globalPass = { removed: 2, outcomes: [{ scope: repoB, outcome: 'fixture global outcome' }] };
for (let index = 0; index < 60; index += 1) {
  for (const [letter, repo] of [['a', repoA], ['b', repoB]] as const) {
    const metadataRoot = path.join(root, 'metadata', `${String(index).padStart(2, '0')}-${letter}`);
    registerMaintenanceRoot(repo, metadataRoot);
    holdMaintenanceRoot(metadataRoot, `${letter} retained evidence`);
  }
}
writeMaintenanceState('last-pass', globalPass);
const route = 'http://localhost/api/orchestrator/workspace/maintenance';
function request(params = new URLSearchParams(), bearer = token) {
  return GET(new NextRequest(`${route}?${params}`, { headers: { host: 'localhost', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) } }));
}
function snapshot() {
  return {
    roots: getSqlite().prepare('SELECT * FROM worktree_maintenance_roots ORDER BY metadata_root').all(),
    state: getSqlite().prepare('SELECT * FROM worktree_maintenance_state ORDER BY key').all(),
  };
}
afterAll(() => {
  closeDb();
  for (const [key, value] of Object.entries(priorEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

describe.sequential('repository-scoped maintenance inventory through authenticated GET', () => {
  it('filters before pagination and preserves canonical scope across database reopen', async () => {
    const before = snapshot();
    const first = await request(new URLSearchParams({ repoPath: repoA }));
    expect(first.status).toBe(200);
    const firstBody = (await first.json()).result;
    expect(firstBody.holds).toHaveLength(50);
    expect(firstBody.holds.every((hold: { repositoryPath: string }) => hold.repositoryPath === repoA)).toBe(true);
    expect(firstBody.repositoryPath).toBe(repoA);
    expect(firstBody.lastPass).toBeNull();
    closeDb();
    const second = await request(new URLSearchParams({ repoPath: alias, after: firstBody.holds.at(-1).metadataRoot }));
    expect(second.status).toBe(200);
    const secondBody = (await second.json()).result;
    expect(secondBody.repositoryPath).toBe(repoA);
    expect(secondBody.holds).toHaveLength(10);
    expect(secondBody.holds.every((hold: { repositoryPath: string }) => hold.repositoryPath === repoA)).toBe(true);
    expect(new Set([...firstBody.holds, ...secondBody.holds].map(hold => hold.metadataRoot)).size).toBe(60);
    expect(secondBody.lastPass).toBeNull();
    expect(snapshot()).toEqual(before);
  });

  it('returns an empty selected scope without falling back to global holds or outcomes', async () => {
    const repoPath = path.join(root, 'unknown-repo');
    const response = await request(new URLSearchParams({ repoPath }));
    expect(response.status).toBe(200);
    expect((await response.json()).result).toMatchObject({ repositoryPath: repoPath, holds: [], lastPass: null });
  });

  it('preserves the existing global status and pagination when scope is omitted', async () => {
    const first = (await (await request()).json()).result;
    expect(first.holds).toHaveLength(50);
    expect(new Set(first.holds.map((hold: { repositoryPath: string }) => hold.repositoryPath))).toEqual(new Set([repoA, repoB]));
    expect(first.lastPass).toEqual(globalPass);
    const second = (await (await request(new URLSearchParams({ after: first.holds.at(-1).metadataRoot }))).json()).result;
    expect(second.holds).toHaveLength(50);
    expect(new Set([...first.holds, ...second.holds].map(hold => hold.metadataRoot)).size).toBe(100);
  });

  it.each(['', 'relative/repo', '/invalid\0repo', `/${'x'.repeat(4_096)}`])('refuses invalid explicit scope %j', async repoPath => {
    const response = await request(new URLSearchParams({ repoPath }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
  });

  it('refuses ambiguous duplicate repository selections', async () => {
    const response = await request(new URLSearchParams([['repoPath', repoA], ['repoPath', repoB]]));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
  });

  it('keeps scoped private inventory unavailable to anonymous and persisted worker callers', async () => {
    const worker = mintPacketWorkerToken('scope-worker');
    closeDb();
    for (const bearer of ['', worker]) {
      const response = await request(new URLSearchParams({ repoPath: repoA }), bearer);
      expect(response.status).toBe(403);
      expect(JSON.stringify(await response.json())).not.toMatch(/retained evidence|metadataRoot|lastPass/);
    }
  });
});
