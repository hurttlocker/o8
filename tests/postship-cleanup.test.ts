import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { cleanupPostshipOutputs, POSTSHIP_GENERATED_DIRS } from '../scripts/postship-cleanup.mjs';

const cleanupRoots: string[] = [];

async function makeRepoRoot() {
  const root = await mkdtemp(path.join(tmpdir(), 'o8-postship-cleanup-'));
  cleanupRoots.push(root);
  await writeFile(path.join(root, 'package.json'), '{"name":"o8"}\n', 'utf8');
  return root;
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(cleanupRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('postship generated-output cleanup', () => {
  it('removes only the exact generated release directories', async () => {
    const root = await makeRepoRoot();
    for (const relativePath of POSTSHIP_GENERATED_DIRS) {
      await mkdir(path.join(root, relativePath), { recursive: true });
      await writeFile(path.join(root, relativePath, 'generated.bin'), 'generated', 'utf8');
    }
    await mkdir(path.join(root, 'src-tauri', 'keep-me'), { recursive: true });
    await writeFile(path.join(root, 'src-tauri', 'keep-me', 'source.txt'), 'keep', 'utf8');

    const result = await cleanupPostshipOutputs(root);

    expect(result).toEqual({ removed: POSTSHIP_GENERATED_DIRS, skipped: [], refused: [] });
    await expect(readFile(path.join(root, 'src-tauri', 'keep-me', 'source.txt'), 'utf8')).resolves.toBe('keep');
  });

  it('refuses a generated-directory symlink without touching its destination', async () => {
    const root = await makeRepoRoot();
    const destination = await mkdtemp(path.join(tmpdir(), 'o8-postship-destination-'));
    cleanupRoots.push(destination);
    await writeFile(path.join(destination, 'valuable.txt'), 'keep', 'utf8');
    await symlink(destination, path.join(root, '.next'));

    const result = await cleanupPostshipOutputs(root);

    expect(result.refused).toEqual([{ path: '.next', reason: 'target is not a real directory' }]);
    await expect(readFile(path.join(destination, 'valuable.txt'), 'utf8')).resolves.toBe('keep');
  });

  it('refuses a linked subtree without traversing or deleting its destination', async () => {
    const root = await makeRepoRoot();
    const destination = await mkdtemp(path.join(tmpdir(), 'o8-postship-nested-destination-'));
    cleanupRoots.push(destination);
    await writeFile(path.join(destination, 'valuable.txt'), 'keep', 'utf8');
    await mkdir(path.join(root, '.next'), { recursive: true });
    await symlink(destination, path.join(root, '.next', 'linked-cache'));

    const result = await cleanupPostshipOutputs(root);

    expect(result.refused).toEqual([{
      path: '.next',
      reason: 'linked entry inside .next: linked-cache',
    }]);
    await expect(readFile(path.join(destination, 'valuable.txt'), 'utf8')).resolves.toBe('keep');
  });
});
