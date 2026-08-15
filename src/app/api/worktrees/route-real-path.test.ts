import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/worktree/storage-telemetry', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/worktree/storage-telemetry')>(),
  measureHostVolume: vi.fn(async () => ({
    accountingStatus: 'observed' as const,
    probePath: '/',
    availableBytes: 90_000_000_000,
    freeBytes: 90_000_000_000,
    totalBytes: 100_000_000_000,
    error: null,
  })),
}));

const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'o8-worktree-delete-real-')));
const dataDir = path.join(root, 'data');
const repoPath = path.join(root, 'repo');
mkdirSync(dataDir);
mkdirSync(repoPath);
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_WORKTREE_ROOT = path.join(root, 'worktrees');

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

git(repoPath, 'init', '-q', '-b', 'main');
git(repoPath, 'config', 'user.name', 'o8 test');
git(repoPath, 'config', 'user.email', 'o8-test@example.test');
writeFileSync(path.join(repoPath, 'tracked.txt'), 'owned\n');
git(repoPath, 'add', 'tracked.txt');
git(repoPath, 'commit', '-qm', 'owned');

const { DELETE, POST } = await import('./route');
const { closeDb, getSqlite } = await import('@/lib/db');
const { getWorktreeManager } = await import('@/lib/worktree/launch');
const { withWorktreeMetaTransaction } = await import('@/lib/worktree/metadata-store');

afterAll(() => {
  closeDb();
  rmSync(root, { recursive: true, force: true });
});

describe('/api/worktrees materialization truth', () => {
  it('materializes and admits an operator-created Claude Code worktree', async () => {
    const before = getSqlite().prepare(`
      SELECT COUNT(*) AS count FROM storage_admission_reservations
      WHERE state = 'committed' AND root_identity_json IS NOT NULL
    `).get() as { count: number };
    const response = await POST(new NextRequest('http://127.0.0.1/api/worktrees', {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: '127.0.0.1' },
      body: JSON.stringify({
        repo: repoPath,
        agentType: 'claude-code',
        taskName: 'truthful operator create',
        branchName: 'inline/truthful-operator-create',
        baseBranch: 'main',
        skipSetup: true,
        isolationPreference: 'git-worktree',
      }),
    }));
    const body = await response.json() as {
      worktree: { id: string; path: string; claudeManaged: boolean };
    };

    expect(response.status).toBe(201);
    expect(existsSync(body.worktree.path)).toBe(true);
    expect(body.worktree.claudeManaged).toBe(false);
    const persisted = (await withWorktreeMetaTransaction(
      repoPath,
      (transaction) => transaction.readAll(),
    ))[body.worktree.id];
    expect(persisted?.materializationIdentity).toBeDefined();
    const after = getSqlite().prepare(`
      SELECT COUNT(*) AS count FROM storage_admission_reservations
      WHERE state = 'committed' AND root_identity_json IS NOT NULL
    `).get() as { count: number };
    expect(after.count).toBe(before.count + 1);
  }, 30_000);

  it('returns a conflict and retains persisted authority when manager cleanup refuses', async () => {
    const manager = getWorktreeManager(repoPath);
    const created = await manager.create({
      agentType: 'codex',
      taskName: 'truthful cleanup',
      baseBranch: 'main',
      managed: true,
      skipSetup: true,
      isolationPreference: 'git-worktree',
    });
    const workspacePath = created.path;
    await withWorktreeMetaTransaction(repoPath, async (transaction) => {
      const entry = (await transaction.readAll())[created.id]!;
      await transaction.save(created.id, {
        ...entry,
        materializationIdentity: undefined,
        materializationParentIdentity: undefined,
      });
    });

    const response = await DELETE(new NextRequest('http://127.0.0.1/api/worktrees', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json', host: '127.0.0.1' },
      body: JSON.stringify({
        repo: repoPath,
        action: 'cleanup',
        worktreeId: created.id,
        force: true,
      }),
    }));
    const body = await response.json() as {
      ok: boolean;
      error: { code: string; message: string };
      worktreeId: string;
    };

    expect(response.status).toBe(409);
    expect(body).toMatchObject({
      ok: false,
      error: { code: 'cleanup_refused' },
      worktreeId: created.id,
    });
    expect(existsSync(workspacePath)).toBe(true);
    expect((await withWorktreeMetaTransaction(
      repoPath,
      (transaction) => transaction.readAll(),
    ))[created.id]).toBeDefined();
  }, 60_000);
});
