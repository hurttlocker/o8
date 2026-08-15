import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { captureWorktreeMaterializationIdentity } from '@/lib/worktree/materialization-identity';
import {
  completeExactManagedDirectoryRetirement,
  finishPendingExactManagedDirectoryRetirements,
  retireExactManagedDirectory,
} from './exact-managed-directory-retirement';

const roots: string[] = [];

function fixture(name: string) {
  const root = mkdtempSync(path.join(tmpdir(), `o8-exact-retire-${name}-`));
  roots.push(root);
  const workspacePath = path.join(root, 'packet-workspace');
  mkdirSync(workspacePath);
  writeFileSync(path.join(workspacePath, 'sentinel.txt'), 'owned bytes');
  return { root, workspacePath };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('exact managed directory retirement', () => {
  it('refuses a same-name replacement after proof and preserves both directories', async () => {
    const { root, workspacePath } = fixture('replacement');
    const identity = await captureWorktreeMaterializationIdentity(workspacePath);
    const retainedPath = path.join(root, 'retained-owner');

    await expect(retireExactManagedDirectory({
      repositoryPath: root,
      worktreeId: 'packet-workspace',
      directoryPath: workspacePath,
      identity,
      beforeRetirementRename: async () => {
        renameSync(workspacePath, retainedPath);
        mkdirSync(workspacePath);
        writeFileSync(path.join(workspacePath, 'unrelated.txt'), 'unrelated bytes');
      },
    })).rejects.toThrow('changed source identity');

    expect(readFileSync(path.join(retainedPath, 'sentinel.txt'), 'utf8')).toBe('owned bytes');
    expect(readFileSync(path.join(workspacePath, 'unrelated.txt'), 'utf8')).toBe('unrelated bytes');
  });

  it('replays a crash after exact rename from its trusted claim', async () => {
    const { root, workspacePath } = fixture('replay');
    const identity = await captureWorktreeMaterializationIdentity(workspacePath);

    await expect(retireExactManagedDirectory({
      repositoryPath: root,
      worktreeId: 'packet-workspace',
      directoryPath: workspacePath,
      identity,
      afterRetirementRename: async () => {
        throw new Error('simulated process death after exact rename');
      },
    })).rejects.toThrow('simulated process death');
    expect(existsSync(workspacePath)).toBe(false);
    expect(readdirSync(root).some((name) => name.startsWith('.o8-retired-managed-'))).toBe(true);

    await expect(finishPendingExactManagedDirectoryRetirements(
      root,
      root,
      await captureWorktreeMaterializationIdentity(root),
      () => true,
    )).resolves.toEqual({
      completed: 1,
      refused: 0,
    });
    expect(readdirSync(root)).toEqual([]);
  });

  it('leaves no retirement namespace across repeated cycles', async () => {
    const { root, workspacePath } = fixture('cycles');
    for (let index = 0; index < 3; index += 1) {
      if (!existsSync(workspacePath)) mkdirSync(workspacePath);
      writeFileSync(path.join(workspacePath, `cycle-${index}.txt`), `cycle ${index}`);
      await retireExactManagedDirectory({
        repositoryPath: root,
        worktreeId: `packet-cycle-${index}`,
        directoryPath: workspacePath,
        identity: await captureWorktreeMaterializationIdentity(workspacePath),
      });
      completeExactManagedDirectoryRetirement(root, `packet-cycle-${index}`);
    }
    expect(readdirSync(root)).toEqual([]);
  }, 15_000);

  it('refuses a replacement retirement root before reading forged receipts', async () => {
    const outer = mkdtempSync(path.join(tmpdir(), 'o8-exact-retire-root-swap-'));
    roots.push(outer);
    const parentPath = path.join(outer, 'managed-base');
    const retainedParent = path.join(outer, 'retained-base');
    mkdirSync(parentPath);
    const parentIdentity = await captureWorktreeMaterializationIdentity(parentPath);
    renameSync(parentPath, retainedParent);
    mkdirSync(parentPath);
    const externalSentinel = path.join(parentPath, 'external-sentinel.txt');
    writeFileSync(externalSentinel, 'external bytes');
    writeFileSync(path.join(parentPath, `.o8-retire-receipt-${'a'.repeat(64)}.json`), '{}');

    await expect(finishPendingExactManagedDirectoryRetirements(
      outer,
      parentPath,
      parentIdentity,
    )).rejects.toThrow('ownership changed');
    expect(readFileSync(externalSentinel, 'utf8')).toBe('external bytes');
    expect(existsSync(retainedParent)).toBe(true);
  });

  it('ignores forged receipt files without trusted database authority', async () => {
    const { root, workspacePath } = fixture('forged-receipt');
    const forgedReceipt = path.join(root, `.o8-retire-receipt-${'b'.repeat(64)}.json`);
    writeFileSync(forgedReceipt, JSON.stringify({
      sourcePath: workspacePath,
      sourceIdentity: await captureWorktreeMaterializationIdentity(workspacePath),
    }));

    await expect(finishPendingExactManagedDirectoryRetirements(
      root,
      root,
      await captureWorktreeMaterializationIdentity(root),
      () => true,
    )).resolves.toEqual({ completed: 0, refused: 0 });
    expect(readFileSync(path.join(workspacePath, 'sentinel.txt'), 'utf8')).toBe('owned bytes');
    expect(existsSync(forgedReceipt)).toBe(true);
  });
});
