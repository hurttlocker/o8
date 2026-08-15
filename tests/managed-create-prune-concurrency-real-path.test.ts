import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, it } from 'vitest';

function waitForFile(candidatePath: string, timeoutMs = 30_000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (existsSync(candidatePath)) return resolve();
      if (Date.now() - started >= timeoutMs) {
        return reject(new Error(`Timed out waiting for ${candidatePath}.`));
      }
      setTimeout(poll, 20);
    };
    poll();
  });
}

it('explicit prune(0) cannot retire a separate-process workspace still being created', async () => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'o8-create-prune-race-')));
  const repo = path.join(root, 'repo');
  const dataDir = path.join(root, 'data');
  const marker = path.join(root, 'create-marker.json');
  const release = path.join(root, 'create-release');
  mkdirSync(repo);
  mkdirSync(dataDir);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  writeFileSync(path.join(repo, 'tracked.txt'), 'owned\n');
  execFileSync('git', ['add', 'tracked.txt'], { cwd: repo });
  execFileSync('git', [
    '-c', 'user.name=o8-test', '-c', 'user.email=o8@example.test',
    'commit', '-q', '-m', 'owned',
  ], { cwd: repo });
  const worktreeRoot = path.join(root, 'worktrees');
  const child = spawn(process.execPath, [
    './node_modules/vitest/vitest.mjs', 'run',
    'tests/fixtures/managed-create-pause-child.test.ts', '--reporter=dot',
  ], {
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      CORTEX_IDE_DATA_DIR: dataDir,
      O8_TEST_DATA_DIR_PINNED: dataDir,
      O8_WORKTREE_ROOT: worktreeRoot,
      O8_SKIP_PRELAUNCH_TYPECHECK: '1',
      O8_TEST_CREATE_PAUSE_REPO: repo,
      O8_TEST_CREATE_PAUSE_MARKER: marker,
      O8_TEST_CREATE_PAUSE_RELEASE: release,
    },
    stdio: 'ignore',
  });
  await waitForFile(marker);
  const receipt = JSON.parse(readFileSync(marker, 'utf8')) as { id: string; path: string };
  process.env.CORTEX_IDE_DATA_DIR = dataDir;
  process.env.O8_WORKTREE_ROOT = worktreeRoot;
  const { WorktreeManager } = await import('@/lib/worktree/manager');
  const manager = new WorktreeManager(repo);

  await expect(manager.prune(0)).resolves.not.toContain(receipt.id);
  expect(existsSync(receipt.path)).toBe(true);
  writeFileSync(release, 'continue');
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => code === 0
      ? resolve()
      : reject(new Error(`Create child exited ${code}.`)));
  });
  await expect(manager.cleanup(
    receipt.id, { force: true, deleteBranch: true, overrideLiveGuard: true },
  )).resolves.toBe(true);
  const { closeDb } = await import('@/lib/db');
  closeDb();
  rmSync(root, { recursive: true, force: true });
}, 90_000);
