import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { WorktreeManager } from './manager';
import { readWorktreeMetaSnapshot } from './metadata-store';
import { resolveWorktreeRootLayout } from './root-layout';

describe('passive worktree metadata reads', () => {
  let priorDataDir: string | undefined;
  let root: string;
  let repoPath: string;

  beforeEach(async () => {
    priorDataDir = process.env.O8_DATA_DIR;
    root = await mkdtemp(path.join(tmpdir(), 'o8-passive-meta-'));
    repoPath = path.join(root, 'repo');
    await mkdir(repoPath);
    process.env.O8_DATA_DIR = path.join(root, 'data');
  });

  afterEach(async () => {
    if (priorDataDir === undefined) delete process.env.O8_DATA_DIR;
    else process.env.O8_DATA_DIR = priorDataDir;
    await rm(root, { recursive: true, force: true });
  });

  it('does not create metadata roots for inventory or dependency reconciliation', async () => {
    const manager = new WorktreeManager(repoPath);
    const worktreeBase = resolveWorktreeRootLayout(repoPath).primaryBase;

    expect(existsSync(worktreeBase)).toBe(false);
    await expect(manager.list()).resolves.toEqual([]);
    await expect(manager.listDependencyMaterializationAuthorities()).resolves.toEqual([]);
    expect(existsSync(worktreeBase)).toBe(false);
  });

  it('prefers durable transaction state when the metadata mirror is stale', async () => {
    const sqlite = new Database(':memory:');
    const worktreeBase = resolveWorktreeRootLayout(repoPath).primaryBase;
    await mkdir(worktreeBase, { recursive: true });
    await writeFile(path.join(worktreeBase, '.meta.json'), JSON.stringify({
      version: 1,
      worktrees: {},
    }));
    sqlite.exec(`
      CREATE TABLE worktree_metadata_state (
        metadata_root TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL,
        mirror_identity_json TEXT,
        updated_at INTEGER NOT NULL
      )
    `);
    sqlite.prepare(`
      INSERT INTO worktree_metadata_state
        (metadata_root, payload_json, mirror_identity_json, updated_at)
      VALUES (?, ?, NULL, ?)
    `).run(worktreeBase, JSON.stringify({
      version: 1,
      worktrees: {
        'packet-durable': {
          id: 'packet-durable',
          agentType: 'codex',
          baseBranch: 'main',
          createdAt: Date.now(),
          claudeManaged: false,
          taskName: 'durable recovery',
          status: 'ready',
        },
      },
    }), Date.now());

    await expect(readWorktreeMetaSnapshot(repoPath, sqlite)).resolves.toMatchObject({
      'packet-durable': { id: 'packet-durable', status: 'ready' },
    });
    sqlite.close();
  });
});
