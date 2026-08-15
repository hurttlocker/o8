import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { withWorktreeMetaTransaction } from '@/lib/worktree/metadata-store';
import { resolveWorktreeRootLayout } from '@/lib/worktree/root-layout';

const roots: string[] = [];
const priorWorktreeRoot = process.env.O8_WORKTREE_ROOT;

afterEach(() => {
  if (priorWorktreeRoot === undefined) delete process.env.O8_WORKTREE_ROOT;
  else process.env.O8_WORKTREE_ROOT = priorWorktreeRoot;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('retired metadata lock pathname', () => {
  it('keeps the transaction valid when that pathname disappears', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'o8-metadata-retired-lock-'));
    roots.push(root);
    process.env.O8_WORKTREE_ROOT = path.join(root, 'worktrees');
    const repoPath = path.join(root, 'repo');
    mkdirSync(repoPath);
    const lockPath = path.join(resolveWorktreeRootLayout(repoPath).primaryBase, '.meta.json.lock');
    mkdirSync(lockPath, { recursive: true });
    writeFileSync(path.join(lockPath, 'sentinel'), 'retired\n');

    await expect(withWorktreeMetaTransaction(repoPath, async () => {
      renameSync(lockPath, `${lockPath}.moved`);
      return 'acquired';
    })).resolves.toBe('acquired');
  });
});
