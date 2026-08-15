import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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

describe('legacy metadata lock path boundary', () => {
  it('does not inspect or delete an unrelated replacement at the retired lock path', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'o8-metadata-legacy-path-'));
    roots.push(root);
    process.env.O8_WORKTREE_ROOT = path.join(root, 'worktrees');
    const repoPath = path.join(root, 'repo');
    mkdirSync(repoPath);
    const lockPath = path.join(resolveWorktreeRootLayout(repoPath).primaryBase, '.meta.json.lock');
    mkdirSync(lockPath, { recursive: true });
    const sentinelPath = path.join(lockPath, 'unrelated-sentinel');
    writeFileSync(sentinelPath, 'must survive\n');

    await expect(withWorktreeMetaTransaction(repoPath, async () => 'acquired'))
      .resolves.toBe('acquired');
    expect(existsSync(lockPath)).toBe(true);
    expect(readFileSync(sentinelPath, 'utf8')).toBe('must survive\n');
  });
});
