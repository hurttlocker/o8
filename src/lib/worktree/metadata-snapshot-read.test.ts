import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { WorktreeManager } from './manager';
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
});
