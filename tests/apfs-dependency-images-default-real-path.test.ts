import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';

import type { RepoRegistryEntry } from '@/lib/repos/types';
import type { DependencyImageProvider } from '@/lib/workspace/dependency-materializer';

const root = mkdtempSync(path.join(os.tmpdir(), 'o8-apfs-default-real-path-'));
const dataDir = path.join(root, 'data');
const repoPath = path.join(root, 'repo');
const workspacePath = path.join(root, 'workspace');
const originalDataDir = process.env.CORTEX_IDE_DATA_DIR;
const originalO8DataDir = process.env.O8_DATA_DIR;
const originalOverride = process.env.O8_APFS_DEPENDENCY_IMAGES;
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_DATA_DIR = dataDir;
delete process.env.O8_APFS_DEPENDENCY_IMAGES;
mkdirSync(dataDir);
mkdirSync(repoPath);

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

git(repoPath, 'init', '-q', '-b', 'main');
writeFileSync(path.join(repoPath, '.gitignore'), 'node_modules/\n');
writeFileSync(path.join(repoPath, 'package.json'), `${JSON.stringify({
  name: 'apfs-default-real-path',
  version: '1.0.0',
  private: true,
  packageManager: 'npm@10.0.0',
})}\n`);
writeFileSync(path.join(repoPath, 'package-lock.json'), `${JSON.stringify({
  name: 'apfs-default-real-path',
  version: '1.0.0',
  lockfileVersion: 3,
  packages: { '': { name: 'apfs-default-real-path', version: '1.0.0' } },
})}\n`);
git(repoPath, 'add', '.gitignore', 'package.json', 'package-lock.json');
git(repoPath, '-c', 'user.name=o8-test', '-c', 'user.email=test@invalid', 'commit', '-qm', 'fixture');
git(repoPath, 'worktree', 'add', '-q', '-b', 'apfs-default-test', workspacePath);

const [{ GET, POST }, { runRegisteredRepoSetup }] = await Promise.all([
  import('@/app/api/panel/operator-defaults/route'),
  import('@/lib/workspace/repo-setup'),
]);

function post(body: unknown): Request {
  return new Request('http://127.0.0.1/api/panel/operator-defaults', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

afterAll(() => {
  if (originalDataDir === undefined) delete process.env.CORTEX_IDE_DATA_DIR;
  else process.env.CORTEX_IDE_DATA_DIR = originalDataDir;
  if (originalO8DataDir === undefined) delete process.env.O8_DATA_DIR;
  else process.env.O8_DATA_DIR = originalO8DataDir;
  if (originalOverride === undefined) delete process.env.O8_APFS_DEPENDENCY_IMAGES;
  else process.env.O8_APFS_DEPENDENCY_IMAGES = originalOverride;
  rmSync(root, { recursive: true, force: true });
});

describe.sequential('APFS dependency images persisted default through production repo setup', () => {
  it('surfaces environment truth without mutating the persisted default', async () => {
    const persistedResponse = await POST(post({ apfsDependencyImages: true }));
    const persisted = await persistedResponse.json();
    expect(persistedResponse.status).toBe(200);
    expect(persisted.values.apfsDependencyImages).toBe(true);
    expect(persisted.effectiveOverride.apfsDependencyImages).toBeNull();

    process.env.O8_APFS_DEPENDENCY_IMAGES = '0';
    const forcedOff = await (await GET()).json();
    expect(forcedOff.values.apfsDependencyImages).toBe(true);
    expect(forcedOff.effectiveOverride.apfsDependencyImages).toBe(false);

    process.env.O8_APFS_DEPENDENCY_IMAGES = '1';
    const forcedOn = await (await GET()).json();
    expect(forcedOn.values.apfsDependencyImages).toBe(true);
    expect(forcedOn.effectiveOverride.apfsDependencyImages).toBe(true);
    delete process.env.O8_APFS_DEPENDENCY_IMAGES;
  }, 15_000);

  it('selects image mode from the persisted default at the real repo-setup chokepoint', async () => {
    delete process.env.O8_APFS_DEPENDENCY_IMAGES;
    const persistedResponse = await POST(post({ apfsDependencyImages: true }));
    expect(persistedResponse.status).toBe(200);
    const lookupReadyImage = vi.fn(async ({ recipe }: Parameters<DependencyImageProvider['lookupReadyImage']>[0]) => ({
      status: 'ready' as const,
      authority: { recipeKey: recipe.key, generation: 'persisted-default-generation' },
    }));
    const mount = vi.fn(async ({
      workspacePath: target,
      recipe,
    }: Parameters<DependencyImageProvider['mount']>[0]) => {
      mkdirSync(path.join(target, 'node_modules', 'fixture'), { recursive: true });
      return {
        leaseId: 'persisted-default-lease',
        recipeKey: recipe.key,
        generation: 'persisted-default-generation',
      };
    });
    const provider: DependencyImageProvider = {
      lookupReadyImage,
      mount,
      captureSource: vi.fn(async () => { throw new Error('unexpected native publication'); }),
      publish: vi.fn(async () => { throw new Error('unexpected native publication'); }),
      detach: vi.fn(async () => {}),
      reconcile: vi.fn(async () => []),
    };
    const run = vi.fn(async () => { throw new Error('unexpected native install'); });
    const repo: RepoRegistryEntry = {
      id: 'apfs-default-real-path',
      name: 'APFS default real path',
      localPath: repoPath,
      remoteUrl: null,
      defaultBranch: 'main',
      addedAt: '2026-08-20T00:00:00.000Z',
      lastOpenedAt: null,
      storagePressureParkingDisabled: false,
      setup: {
        envMode: 'skip',
        envFiles: [],
        installCommand: 'npm ci --prefer-offline --ignore-scripts',
        installOnCreateWorkspace: true,
        buildCommand: null,
        runBuildOnCreateWorkspace: false,
        devCommand: null,
        defaultPort: null,
        workspaceIsolationPreference: 'auto',
      },
    };

    expect(process.env.O8_APFS_DEPENDENCY_IMAGES).toBeUndefined();
    const receipt = await runRegisteredRepoSetup(repo, workspacePath, {
      run,
      resolvePackageManagerVersion: async () => '10.0.0',
      dependencyImageProvider: provider,
      dependencyImagePlatform: 'darwin',
      probeDependencyImageApfs: async () => true,
    });

    expect(receipt.install.materialization).toMatchObject({
      mode: 'image',
      status: 'mounted',
      leaseId: 'persisted-default-lease',
      generation: 'persisted-default-generation',
    });
    expect(receipt.install.privateViewVerified).toBe(true);
    expect(lookupReadyImage).toHaveBeenCalledOnce();
    expect(mount).toHaveBeenCalledOnce();
    expect(run).not.toHaveBeenCalled();
  }, 15_000);
});
