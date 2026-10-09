import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { afterEach, expect, it, vi } from 'vitest';

// Interrupt only the boundary after the native purge child settles. All claim,
// identity, authorization, and filesystem operations use the production code.
const hooks = vi.hoisted(() => ({
  afterRelease: null as ((candidatePath: string) => Promise<void>) | null,
  interruptAfterRemoval: false,
}));
vi.mock('@/lib/workspace/exact-parent-operation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/workspace/exact-parent-operation')>();
  return {
    ...actual,
    removeExactEmptyChildDirectory: async (...args: Parameters<typeof actual.removeExactEmptyChildDirectory>) => {
      await actual.removeExactEmptyChildDirectory(...args);
      if (hooks.interruptAfterRemoval) throw new Error('interrupted after authorized empty removal');
    },
  };
});
vi.mock('@/lib/workspace/exact-directory-purge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/workspace/exact-directory-purge')>();
  return {
    ...actual,
    purgeExactDirectory: (...args: Parameters<typeof actual.purgeExactDirectory>) => {
      const afterRelease = args[4];
      args[4] = async (candidatePath) => {
        await hooks.afterRelease?.(candidatePath);
        await afterRelease?.(candidatePath);
      };
      return actual.purgeExactDirectory(...args);
    },
  };
});

import { captureWorktreeMaterializationIdentity } from '@/lib/worktree/materialization-identity';
import { probeMetadataLockProcessIdentity } from '@/lib/worktree/metadata-lock-process-identity';
import { readWorktreeMetaSnapshot, withWorktreeMetaTransaction } from '@/lib/worktree/metadata-store';
import {
  completeExactManagedDirectoryRetirement,
  finishPendingExactManagedDirectoryRetirements,
  retireExactManagedDirectory,
} from '@/lib/workspace/exact-managed-directory-retirement';
import { readExactWorkspaceClaim, removeExactWorkspaceClaim } from '@/lib/workspace/exact-workspace-claim-state';
import { readExactManagedFinalization } from '@/lib/workspace/exact-managed-finalization-state';
import {
  acquireWorkspaceRetentionHold,
  getWorkspaceRetentionHold,
  releaseWorkspaceRetentionHold,
} from '@/lib/workspace/retention-holds';

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const holds: Parameters<typeof releaseWorkspaceRetentionHold>[0][] = [];

async function fixture(deadCreator = false) {
  const root = mkdtempSync(path.join(tmpdir(), 'o8-purge-finalization-'));
  roots.push(root);
  const workspacePath = path.join(root, 'owned-workspace');
  mkdirSync(workspacePath);
  writeFileSync(path.join(workspacePath, 'owned.txt'), 'owned retirement bytes');
  const child = deadCreator ? spawn(process.execPath, ['-e',
    "process.stdin.resume(); process.stdin.once('end', () => process.exit(0));",
  ], { stdio: ['pipe', 'ignore', 'ignore'] }) : null;
  const closed = child ? new Promise<number | null>((resolve) => child.once('close', resolve)) : null;
  try {
    const creatorPid = child?.pid ?? process.pid;
    const creator = await probeMetadataLockProcessIdentity(creatorPid);
    if (creator.state !== 'live') throw new Error('Fixture creator identity is not proven live.');
    await withWorktreeMetaTransaction(root, async (transaction) => transaction.save('owned-workspace', {
      id: 'owned-workspace', agentType: 'codex', baseBranch: 'main', createdAt: Date.now(),
      claudeManaged: false, taskName: 'Interrupted fixture creation', status: 'creating',
      materializationIdentity: await captureWorktreeMaterializationIdentity(workspacePath),
      materializationParentIdentity: await captureWorktreeMaterializationIdentity(root),
      creationOwner: { pid: creatorPid, identity: creator.identity },
    }));
  } finally {
    child?.stdin!.end();
    if (closed) expect(await closed).toBe(0);
  }
  return {
    root, workspacePath,
    input: {
      repositoryPath: root, worktreeId: 'owned-workspace', directoryPath: workspacePath,
      identity: await captureWorktreeMaterializationIdentity(workspacePath),
      retirementReason: 'creation-rollback' as const,
    },
  };
}

async function coldReplay(root: string): Promise<{ completed: number; refused: number }> {
  const moduleUrl = pathToFileURL(path.join(process.cwd(),
    'src/lib/workspace/exact-managed-directory-retirement.ts')).href;
  const script = `
    const namespace = await import(${JSON.stringify(moduleUrl)});
    const { finishPendingExactManagedDirectoryRetirements } = namespace.default ?? namespace;
    const input = JSON.parse(process.env.O8_FINALIZATION_TEST_INPUT);
    const result = await finishPendingExactManagedDirectoryRetirements(
      input.root, input.root, input.parentIdentity, () => true,
    );
    console.log('O8_FINALIZATION_RESULT ' + JSON.stringify(result));
  `;
  const { stdout } = await execFileAsync(process.execPath,
    ['--import', 'tsx', '--conditions=react-server', '--input-type=module', '-e', script], {
      cwd: process.cwd(), timeout: 20_000, maxBuffer: 1024 * 1024,
      env: {
        ...process.env,
        TSX_TSCONFIG_PATH: path.join(process.cwd(), 'tsconfig.json'),
        O8_FINALIZATION_TEST_INPUT: JSON.stringify({
          root, parentIdentity: await captureWorktreeMaterializationIdentity(root),
        }),
      },
    });
  return JSON.parse(/O8_FINALIZATION_RESULT (\{[^\n]+\})/.exec(stdout)![1]);
}

afterEach(() => {
  hooks.afterRelease = null;
  hooks.interruptAfterRemoval = false;
  for (const hold of holds.splice(0)) releaseWorkspaceRetentionHold(hold);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it('preserves held and unrelated empty retirement-style siblings while finalizing its own claim', async () => {
  const { root, workspacePath, input } = await fixture();
  const heldPath = path.join(root, '.o8-retired-tree-held-evidence');
  const unrelatedPath = path.join(root, '.o8-retired-tree-unrelated-owner');
  mkdirSync(heldPath);
  mkdirSync(unrelatedPath);
  const heldIdentity = await captureWorktreeMaterializationIdentity(heldPath);
  const unrelatedIdentity = await captureWorktreeMaterializationIdentity(unrelatedPath);
  const hold = {
    repositoryUuid: root, packetId: 'held-evidence', holdId: 'required-acceptance-evidence',
  };
  acquireWorkspaceRetentionHold({
    ...hold, repositoryPath: root, worktreeId: 'held-evidence', laneId: 'fixture-held-lane',
    identity: heldIdentity, reason: 'Required acceptance evidence',
  });
  holds.push(hold);

  await retireExactManagedDirectory(input);
  const completedClaim = readExactWorkspaceClaim('managed-retirement', root, input.worktreeId)!;
  completeExactManagedDirectoryRetirement(root, input.worktreeId);
  expect(readExactManagedFinalization(completedClaim)?.state).toBe('complete');

  expect(existsSync(workspacePath)).toBe(false);
  expect(await captureWorktreeMaterializationIdentity(heldPath)).toEqual(heldIdentity);
  expect(await captureWorktreeMaterializationIdentity(unrelatedPath)).toEqual(unrelatedIdentity);
  expect(getWorkspaceRetentionHold(heldPath, heldIdentity)?.holdId).toBe(hold.holdId);
  expect(readdirSync(root).sort()).toEqual([
    path.basename(heldPath), path.basename(unrelatedPath),
  ].sort());
});

it('replays a persisted empty claim in a fresh process after interruption at final removal', async () => {
  const { root, input } = await fixture(true);
  hooks.afterRelease = async () => { throw new Error('interrupted before final removal'); };
  await expect(retireExactManagedDirectory(input)).rejects.toThrow('interrupted before final removal');
  const claim = readExactWorkspaceClaim('managed-retirement', root, input.worktreeId)!;
  expect(claim.state).toBe('purging');
  expect(readdirSync(claim.claimPath)).toEqual([]);
  expect(await captureWorktreeMaterializationIdentity(claim.claimPath)).toMatchObject({
    device: input.identity.device, inode: input.identity.inode,
  });
  hooks.afterRelease = null;
  await expect(coldReplay(root)).resolves.toEqual({ completed: 1, refused: 0 });
  expect(readExactWorkspaceClaim('managed-retirement', root, input.worktreeId)).toBeNull();
  expect(readExactManagedFinalization(claim)?.state).toBe('complete');
  expect(readdirSync(root)).toEqual([]);
});

it('refuses a replacement at final removal and retains the original claim for replay', async () => {
  const { root, input } = await fixture();
  const retainedPath = path.join(root, 'retained-original-claim');
  hooks.afterRelease = async (candidatePath) => {
    renameSync(candidatePath, retainedPath);
    mkdirSync(candidatePath);
    writeFileSync(path.join(candidatePath, 'replacement.txt'), 'unrelated replacement bytes');
  };
  await expect(retireExactManagedDirectory(input)).rejects.toThrow(/changed.*identity|ownership changed/);
  const claim = readExactWorkspaceClaim('managed-retirement', root, input.worktreeId)!;
  expect(claim.state).toBe('purging');
  expect(readFileSync(path.join(claim.claimPath, 'replacement.txt'), 'utf8'))
    .toBe('unrelated replacement bytes');
  expect(await captureWorktreeMaterializationIdentity(retainedPath)).toMatchObject({
    device: input.identity.device, inode: input.identity.inode,
  });
  hooks.afterRelease = null;
  await expect(finishPendingExactManagedDirectoryRetirements(
    root, root, await captureWorktreeMaterializationIdentity(root), () => true,
  )).resolves.toEqual({ completed: 0, refused: 1 });
  expect(readExactWorkspaceClaim('managed-retirement', root, input.worktreeId)?.operationId)
    .toBe(claim.operationId);
  expect(readFileSync(path.join(claim.claimPath, 'replacement.txt'), 'utf8'))
    .toBe('unrelated replacement bytes');
});

it('refuses unexpected contents without moving the directory outside its durable claim', async () => {
  const { root, input } = await fixture();
  hooks.afterRelease = async (candidatePath) => {
    writeFileSync(path.join(candidatePath, 'returned-owner.txt'), 'new owner bytes');
  };
  await expect(retireExactManagedDirectory(input)).rejects.toThrow('non-empty directory');
  const claim = readExactWorkspaceClaim('managed-retirement', root, input.worktreeId)!;
  expect(readFileSync(path.join(claim.claimPath, 'returned-owner.txt'), 'utf8')).toBe('new owner bytes');
  expect(await captureWorktreeMaterializationIdentity(claim.claimPath)).toMatchObject({
    device: input.identity.device, inode: input.identity.inode,
  });
  expect(readdirSync(root)).toEqual([path.basename(claim.claimPath)]);
  hooks.afterRelease = null;
  await expect(finishPendingExactManagedDirectoryRetirements(
    root, root, await captureWorktreeMaterializationIdentity(root), () => true,
  )).resolves.toEqual({ completed: 0, refused: 1 });
  expect(readFileSync(path.join(claim.claimPath, 'returned-owner.txt'), 'utf8')).toBe('new owner bytes');
});

it('preserves the empty namespace when its owning journal is withdrawn before final removal', async () => {
  const { root, input } = await fixture();
  let candidate = '';
  hooks.afterRelease = async (candidatePath) => {
    candidate = candidatePath;
    const claim = readExactWorkspaceClaim('managed-retirement', root, input.worktreeId)!;
    removeExactWorkspaceClaim('managed-retirement', root, input.worktreeId, claim.operationId);
  };
  await expect(retireExactManagedDirectory(input)).rejects.toThrow('lost its owning purge claim');
  expect(await captureWorktreeMaterializationIdentity(candidate)).toMatchObject({
    device: input.identity.device, inode: input.identity.inode,
  });
  expect(readdirSync(candidate)).toEqual([]);
  hooks.afterRelease = null;
  await expect(finishPendingExactManagedDirectoryRetirements(
    root, root, await captureWorktreeMaterializationIdentity(root), () => true,
  )).resolves.toEqual({ completed: 0, refused: 0 });
  expect(existsSync(candidate)).toBe(true);
});

it('refuses a returned source after content release and preserves its bytes, metadata, and claim', async () => {
  const { root, workspacePath, input } = await fixture();
  const metadata = (await readWorktreeMetaSnapshot(root))[input.worktreeId];
  hooks.afterRelease = async () => {
    mkdirSync(workspacePath);
    writeFileSync(path.join(workspacePath, 'returned-source.txt'), 'new source owner bytes');
  };
  await expect(retireExactManagedDirectory(input)).rejects.toThrow('source reappeared');
  const claim = readExactWorkspaceClaim('managed-retirement', root, input.worktreeId)!;
  expect(readdirSync(claim.claimPath)).toEqual([]);
  expect(readExactManagedFinalization(claim)).toBeNull();
  expect(readFileSync(path.join(workspacePath, 'returned-source.txt'), 'utf8')).toBe('new source owner bytes');
  expect((await readWorktreeMetaSnapshot(root))[input.worktreeId]).toEqual(metadata);
  hooks.afterRelease = null;
  await expect(finishPendingExactManagedDirectoryRetirements(
    root, root, await captureWorktreeMaterializationIdentity(root), () => true,
  )).resolves.toEqual({ completed: 0, refused: 1 });
  expect(readExactWorkspaceClaim('managed-retirement', root, input.worktreeId)?.operationId).toBe(claim.operationId);
  expect(readFileSync(path.join(workspacePath, 'returned-source.txt'), 'utf8')).toBe('new source owner bytes');
});

it('cold-replays authorized removal after interruption and retains the final receipt after claim clearing', async () => {
  const { root, workspacePath, input } = await fixture(true);
  hooks.interruptAfterRemoval = true;
  await expect(retireExactManagedDirectory(input)).rejects.toThrow('interrupted after authorized empty removal');
  const claim = readExactWorkspaceClaim('managed-retirement', root, input.worktreeId)!;
  expect(readExactManagedFinalization(claim)?.state).toBe('admitted');
  expect(existsSync(workspacePath)).toBe(false);
  expect(existsSync(claim.claimPath)).toBe(false);
  hooks.interruptAfterRemoval = false;
  await expect(coldReplay(root)).resolves.toEqual({ completed: 1, refused: 0 });
  expect(readExactWorkspaceClaim('managed-retirement', root, input.worktreeId)).toBeNull();
  expect(readExactManagedFinalization(claim)).toMatchObject({
    state: 'complete', outcome: 'absent-after-admission',
  });
  expect(readdirSync(root)).toEqual([]);
});

it('refuses cold replay of unexplained disappearance before final-empty admission', async () => {
  const { root, input } = await fixture(true);
  const retainedPath = path.join(root, 'retained-unadmitted-claim');
  hooks.afterRelease = async (candidatePath) => {
    renameSync(candidatePath, retainedPath);
    throw new Error('claim disappeared before final-empty admission');
  };
  await expect(retireExactManagedDirectory(input)).rejects.toThrow('claim disappeared before final-empty admission');
  const claim = readExactWorkspaceClaim('managed-retirement', root, input.worktreeId)!;
  expect(claim.state).toBe('purging');
  expect(readExactManagedFinalization(claim)).toBeNull();
  expect(() => completeExactManagedDirectoryRetirement(root, input.worktreeId)).toThrow('without a completion receipt');
  hooks.afterRelease = null;
  await expect(coldReplay(root)).resolves.toEqual({ completed: 0, refused: 1 });
  expect(readExactWorkspaceClaim('managed-retirement', root, input.worktreeId)?.operationId).toBe(claim.operationId);
  expect(readExactManagedFinalization(claim)).toBeNull();
  expect(await captureWorktreeMaterializationIdentity(retainedPath)).toMatchObject({
    device: input.identity.device, inode: input.identity.inode,
  });
});
