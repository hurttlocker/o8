import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, it, vi } from 'vitest';

function makeRepo(root: string): string {
  const repoRoot = path.join(root, 'repo');
  mkdirSync(repoRoot);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
  writeFileSync(path.join(repoRoot, 'README.md'), 'base\n');
  execFileSync('git', ['add', 'README.md'], { cwd: repoRoot });
  execFileSync('git', [
    '-c', 'user.name=o8-test', '-c', 'user.email=o8@example.test',
    'commit', '-q', '-m', 'base',
  ], { cwd: repoRoot });
  return repoRoot;
}

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

it.each(['git-worktree', 'apfs-cow-clone'] as const)(
  'reclaims a %s workspace after a crash following materialization but before final bind',
  async (isolationKind) => {
    const root = mkdtempSync(path.join(os.tmpdir(), `o8-create-crash-${isolationKind}-`));
    const repoRoot = makeRepo(root);
    const dataDir = process.env.CORTEX_IDE_DATA_DIR!;
    const worktreeRoot = path.join(root, 'worktrees');
    const marker = path.join(root, 'crash-marker.json');
    const packetId = `crash-${isolationKind}-${Date.now()}`;
    const child = spawn(process.execPath, [
      './node_modules/vitest/vitest.mjs', 'run',
      'tests/fixtures/managed-creation-crash-child.test.ts', '--reporter=dot',
    ], {
      cwd: path.resolve('.'),
      env: {
        ...process.env,
        CORTEX_IDE_DATA_DIR: dataDir,
        O8_TEST_DATA_DIR_PINNED: dataDir,
        O8_WORKTREE_ROOT: worktreeRoot,
        O8_SKIP_PRELAUNCH_TYPECHECK: '1',
        O8_TEST_CRASH_REPO: repoRoot,
        O8_TEST_CRASH_MARKER: marker,
        O8_TEST_CRASH_PACKET: packetId,
        O8_TEST_CRASH_ISOLATION: isolationKind,
      },
      stdio: 'ignore',
    });
    await waitForFile(marker);
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', () => resolve());
      });
    }
    const receipt = JSON.parse(readFileSync(marker, 'utf8')) as {
      id: string;
      worktreePath: string;
      identity: { device: number; inode: number; canonicalPath: string };
      isolationKind: string;
    };
    expect(receipt.isolationKind).toBe(isolationKind);
    expect(receipt.identity.canonicalPath).toBe(realpathSync(receipt.worktreePath));
    process.env.CORTEX_IDE_DATA_DIR = dataDir;
    process.env.O8_WORKTREE_ROOT = worktreeRoot;
    const { WorktreeManager } = await import('@/lib/worktree/manager');

    await expect(new WorktreeManager(repoRoot).cleanup(
      receipt.id, { force: true, overrideLiveGuard: true },
    )).resolves.toBe(true);
    expect(existsSync(receipt.worktreePath)).toBe(false);
    const { closeDb } = await import('@/lib/db');
    closeDb();
  },
  90_000,
);

it('reclaims an already absent managed directory once and preserves mismatch refusal', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'o8-cleanup-absent-replay-'));
  const repoRoot = makeRepo(root);
  const dataDir = process.env.CORTEX_IDE_DATA_DIR!;
  const worktreeRoot = path.join(root, 'worktrees');
  process.env.CORTEX_IDE_DATA_DIR = dataDir;
  process.env.O8_WORKTREE_ROOT = worktreeRoot;
  const { WorktreeManager } = await import('@/lib/worktree/manager');
  const { captureWorktreeMaterializationIdentity } = await import('@/lib/worktree/materialization-identity');
  const { withWorktreeMetaTransaction } = await import('@/lib/worktree/metadata-store');
  const { resolveWorktreeRootLayout } = await import('@/lib/worktree/root-layout');
  const { closeDb } = await import('@/lib/db');
  const layout = resolveWorktreeRootLayout(repoRoot);
  mkdirSync(layout.primaryBase, { recursive: true });
  const parentIdentity = await captureWorktreeMaterializationIdentity(layout.primaryBase);

  const saveEntry = async (id: string, workspacePath: string) => {
    const materializationIdentity = await captureWorktreeMaterializationIdentity(workspacePath);
    await withWorktreeMetaTransaction(repoRoot, (transaction) => transaction.save(id, {
      id,
      agentType: 'worker',
      baseBranch: 'main',
      createdAt: Date.now(),
      claudeManaged: false,
      taskName: id,
      branchName: `inline/${id}`,
      status: 'ready',
      isolationKind: 'apfs-cow-clone',
      materializationIdentity,
      materializationParentIdentity: parentIdentity,
    }));
  };

  const absentId = 'packet-absent-retirement';
  const absentPath = path.join(layout.primaryBase, absentId);
  mkdirSync(absentPath);
  writeFileSync(path.join(absentPath, 'owned.txt'), 'owned bytes');
  await saveEntry(absentId, absentPath);
  rmSync(absentPath, { recursive: true });

  const mismatchId = 'packet-mismatched-retirement';
  const mismatchPath = path.join(layout.primaryBase, mismatchId);
  const retainedMismatchPath = path.join(root, 'retained-mismatched-retirement');
  mkdirSync(mismatchPath);
  writeFileSync(path.join(mismatchPath, 'owned.txt'), 'owned bytes');
  await saveEntry(mismatchId, mismatchPath);
  renameSync(mismatchPath, retainedMismatchPath);
  mkdirSync(mismatchPath);
  writeFileSync(path.join(mismatchPath, 'replacement.txt'), 'replacement bytes');

  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const manager = new WorktreeManager(repoRoot);
    const firstSweep = await manager.prune(0);
    const metadataAfterFirst = await withWorktreeMetaTransaction(
      repoRoot,
      async (transaction) => (await transaction.readAll())[absentId],
    );
    const secondSweep = await manager.prune(0);
    const metadataAfterSecond = await withWorktreeMetaTransaction(
      repoRoot,
      async (transaction) => (await transaction.readAll())[absentId],
    );
    const mismatchRemoved = await manager.cleanup(
      mismatchId, { force: true, overrideLiveGuard: true },
    );
    const absentRefusals = errorSpy.mock.calls.filter((args) => (
      args.some((argument) => String(argument).includes(absentId))
    ));

    expect({
      firstSweep,
      metadataAfterFirst: Boolean(metadataAfterFirst),
      secondSweep,
      metadataAfterSecond: Boolean(metadataAfterSecond),
      absentRefusals: absentRefusals.length,
    }).toEqual({
      firstSweep: [absentId],
      metadataAfterFirst: false,
      secondSweep: [],
      metadataAfterSecond: false,
      absentRefusals: 0,
    });
    expect(mismatchRemoved).toBe(false);
    expect(readFileSync(path.join(mismatchPath, 'replacement.txt'), 'utf8'))
      .toBe('replacement bytes');
    expect(readFileSync(path.join(retainedMismatchPath, 'owned.txt'), 'utf8'))
      .toBe('owned bytes');
  } finally {
    errorSpy.mockRestore();
    closeDb();
  }
}, 30_000);

it.each(['pr', 'merge'] as const)('replays %s cleanup after a crash following the exact retirement rename', async (action) => {
  const root = mkdtempSync(path.join(os.tmpdir(), `o8-cleanup-${action}-crash-replay-`));
  const repoRoot = makeRepo(root);
  const dataDir = process.env.CORTEX_IDE_DATA_DIR!;
  const worktreeRoot = path.join(root, 'worktrees');
  const marker = path.join(root, 'retirement-marker');
  process.env.CORTEX_IDE_DATA_DIR = dataDir;
  process.env.O8_WORKTREE_ROOT = worktreeRoot;
  const { WorktreeManager } = await import('@/lib/worktree/manager');
  const { captureWorktreeMaterializationIdentity } = await import('@/lib/worktree/materialization-identity');
  const { withWorktreeMetaTransaction } = await import('@/lib/worktree/metadata-store');
  const { resolveWorktreeRootLayout } = await import('@/lib/worktree/root-layout');
  const { createWorkspaceSnapshot, getWorkspaceSnapshot } = await import('@/lib/worktree/snapshot-state');
  const layout = resolveWorktreeRootLayout(repoRoot);
  mkdirSync(layout.primaryBase, { recursive: true });
  const id = 'packet-cleanup-crash-replay';
  const worktreePath = path.join(layout.primaryBase, id);
  execFileSync('git', [
    'worktree', 'add', '-q', '-b', `inline/${id}`, worktreePath, 'main',
  ], { cwd: repoRoot });
  const materializationIdentity = await captureWorktreeMaterializationIdentity(worktreePath);
  const materializationParentIdentity = await captureWorktreeMaterializationIdentity(layout.primaryBase);
  await withWorktreeMetaTransaction(repoRoot, (transaction) => transaction.save(id, {
    id,
    agentType: 'codex',
    baseBranch: 'main',
    createdAt: Date.now(),
    claudeManaged: false,
    taskName: id,
    branchName: `inline/${id}`,
    status: 'ready',
    isolationKind: 'git-worktree',
    materializationIdentity,
    materializationParentIdentity,
  }));
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktreePath, encoding: 'utf8' }).trim();
  const tree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: worktreePath, encoding: 'utf8' }).trim();
  const repositoryUuid = `cleanup-crash-${action}`;
  createWorkspaceSnapshot({
    repositoryUuid,
    packetId: id,
    laneId: null,
    originalPath: worktreePath,
    branch: `inline/${id}`,
    baseCommit: head,
    headCommit: head,
    treeSha: tree,
    recoveryRef: `refs/o8/recovery/${id}`,
    diffFingerprint: `${id}-diff`,
    sessionIdentities: [],
    creationId: `${id}-created`,
  });
  const { closeDb } = await import('@/lib/db');
  closeDb();
  const child = spawn(process.execPath, [
    './node_modules/vitest/vitest.mjs', 'run',
    'tests/fixtures/managed-cleanup-crash-child.test.ts', '--reporter=dot',
  ], {
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      CORTEX_IDE_DATA_DIR: dataDir,
      O8_TEST_DATA_DIR_PINNED: dataDir,
      O8_WORKTREE_ROOT: worktreeRoot,
      O8_TEST_RETIRE_CRASH_REPO: repoRoot,
      O8_TEST_RETIRE_CRASH_MARKER: marker,
      O8_TEST_RETIRE_CRASH_WORKTREE: id,
      O8_TEST_RETIRE_CRASH_ACTION: action,
    },
    stdio: 'ignore',
  });
  await waitForFile(marker);
  if (child.exitCode === null && child.signalCode === null) {
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', () => resolve());
    });
  }

  const manager = new WorktreeManager(repoRoot);
  await expect(manager.prune(0)).resolves.toContain(id);
  expect(existsSync(worktreePath)).toBe(false);
  await expect(withWorktreeMetaTransaction(
    repoRoot,
    async (transaction) => (await transaction.readAll())[id],
  )).resolves.toBeUndefined();
  expect(getWorkspaceSnapshot(repositoryUuid, id)?.state).toBe('retired');
  closeDb();
}, 90_000);
