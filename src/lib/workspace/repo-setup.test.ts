import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RepoRegistryEntry } from '@/lib/repos/types';
import {
  repoSetupCopyBindingRequirements,
  runRegisteredRepoSetup,
} from './repo-setup';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('registered repo restore setup', () => {
  it('runs the saved non-npm package-manager command and records no secret values', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'o8-repo-setup-'));
    roots.push(root);
    const repoPath = path.join(root, 'repo');
    const workspacePath = path.join(root, 'workspace');
    mkdirSync(repoPath);
    mkdirSync(workspacePath);
    writeFileSync(path.join(repoPath, '.env.local'), 'TOKEN=super-secret-value\n');
    const repo: RepoRegistryEntry = {
      id: 'repo-setup-test',
      name: 'setup-test',
      localPath: repoPath,
      remoteUrl: null,
      defaultBranch: 'main',
      addedAt: '2026-08-14T00:00:00.000Z',
      lastOpenedAt: null,
      storagePressureParkingDisabled: false,
      setup: {
        envMode: 'copy',
        envFiles: ['.env.local'],
        installCommand: 'pnpm install --frozen-lockfile',
        installOnCreateWorkspace: true,
        buildCommand: null,
        runBuildOnCreateWorkspace: false,
        devCommand: null,
        defaultPort: null,
        workspaceIsolationPreference: 'git-worktree',
      },
    };
    const run = vi.fn(async () => {});

    const receipt = await runRegisteredRepoSetup(repo, workspacePath, { run });

    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      command: 'pnpm install --frozen-lockfile',
      cwd: workspacePath,
    }));
    expect(readFileSync(path.join(workspacePath, '.env.local'), 'utf8')).toContain('super-secret-value');
    expect(receipt.install.packageManager).toBe('pnpm');
    expect(JSON.stringify(receipt)).not.toContain('super-secret-value');
    expect(receipt.envBindings[0]?.bindingId).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each(['target', 'ancestor'] as const)('refuses an existing %s symlink without changing its external file', async (kind) => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'o8-repo-setup-symlink-'));
    roots.push(root);
    const repoPath = path.join(root, 'repo');
    const workspacePath = path.join(root, 'workspace');
    const externalPath = path.join(root, 'external');
    mkdirSync(repoPath);
    mkdirSync(workspacePath);
    mkdirSync(externalPath);
    writeFileSync(path.join(repoPath, '.env.local'), 'TOKEN=new-secret\n');
    writeFileSync(path.join(externalPath, 'sentinel'), 'keep-me\n');
    const relativePath = kind === 'target' ? '.env.local' : 'config/.env.local';
    if (kind === 'target') symlinkSync(path.join(externalPath, 'sentinel'), path.join(workspacePath, '.env.local'));
    else symlinkSync(externalPath, path.join(workspacePath, 'config'));
    const repo = {
      id: 'repo-setup-symlink-test',
      name: 'setup-test',
      localPath: repoPath,
      remoteUrl: null,
      defaultBranch: 'main',
      addedAt: '2026-08-14T00:00:00.000Z',
      lastOpenedAt: null,
      storagePressureParkingDisabled: false,
      setup: {
        envMode: 'copy' as const,
        envFiles: [relativePath],
        installCommand: null,
        installOnCreateWorkspace: false,
        buildCommand: null,
        runBuildOnCreateWorkspace: false,
        devCommand: null,
        defaultPort: null,
        workspaceIsolationPreference: 'git-worktree' as const,
      },
    };
    if (kind === 'ancestor') {
      mkdirSync(path.join(repoPath, 'config'));
      writeFileSync(path.join(repoPath, relativePath), 'TOKEN=new-secret\n');
    }

    await expect(runRegisteredRepoSetup(repo, workspacePath)).rejects.toThrow(/destination/);
    expect(readFileSync(path.join(externalPath, 'sentinel'), 'utf8')).toBe('keep-me\n');
  });

  it('refuses a copied environment source that changes after capture', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'o8-repo-setup-drift-'));
    roots.push(root);
    const repoPath = path.join(root, 'repo');
    const workspacePath = path.join(root, 'workspace');
    mkdirSync(repoPath);
    mkdirSync(workspacePath);
    const source = path.join(repoPath, '.env.local');
    writeFileSync(source, 'TOKEN=original\n');
    const repo: RepoRegistryEntry = {
      id: 'repo-setup-drift-test',
      name: 'setup-test',
      localPath: repoPath,
      remoteUrl: null,
      defaultBranch: 'main',
      addedAt: '2026-08-14T00:00:00.000Z',
      lastOpenedAt: null,
      storagePressureParkingDisabled: false,
      setup: {
        envMode: 'copy',
        envFiles: ['.env.local'],
        installCommand: null,
        installOnCreateWorkspace: false,
        buildCommand: null,
        runBuildOnCreateWorkspace: false,
        devCommand: null,
        defaultPort: null,
        workspaceIsolationPreference: 'git-worktree',
      },
    };
    const requiredCopyBindings = await repoSetupCopyBindingRequirements(repo);
    writeFileSync(source, 'TOKEN=changed\n');

    await expect(runRegisteredRepoSetup(repo, workspacePath, {
      requiredCopyBindings,
    })).rejects.toThrow(/changed before copy/);
    expect(existsSync(path.join(workspacePath, '.env.local'))).toBe(false);
  });

  it.each(['copy', 'symlink'] as const)(
    'pins the destination parent before creating a %s binding',
    async (envMode) => {
      const root = mkdtempSync(path.join(os.tmpdir(), `o8-repo-setup-parent-race-${envMode}-`));
      roots.push(root);
      const repoPath = path.join(root, 'repo');
      const workspacePath = path.join(root, 'workspace');
      const externalPath = path.join(root, 'external');
      const capturedParent = path.join(root, 'captured-workspace-parent');
      mkdirSync(path.join(repoPath, 'config'), { recursive: true });
      mkdirSync(path.join(workspacePath, 'config'), { recursive: true });
      mkdirSync(externalPath);
      writeFileSync(path.join(repoPath, 'config/.env.local'), 'TOKEN=must-not-escape\n');
      writeFileSync(path.join(externalPath, 'sentinel'), 'external bytes survive\n');
      const repo: RepoRegistryEntry = {
        id: `repo-setup-parent-race-${envMode}`,
        name: 'setup-test',
        localPath: repoPath,
        remoteUrl: null,
        defaultBranch: 'main',
        addedAt: '2026-08-14T00:00:00.000Z',
        lastOpenedAt: null,
        storagePressureParkingDisabled: false,
        setup: {
          envMode,
          envFiles: ['config/.env.local'],
          installCommand: null,
          installOnCreateWorkspace: false,
          buildCommand: null,
          runBuildOnCreateWorkspace: false,
          devCommand: null,
          defaultPort: null,
          workspaceIsolationPreference: 'git-worktree',
        },
      };

      await expect(runRegisteredRepoSetup(repo, workspacePath, {
        beforeBindingCreate: async (_relativePath, parentPath) => {
          renameSync(parentPath, capturedParent);
          symlinkSync(externalPath, parentPath, 'dir');
        },
      })).rejects.toThrow('destination parent identity changed');

      expect(readFileSync(path.join(externalPath, 'sentinel'), 'utf8')).toBe('external bytes survive\n');
      expect(existsSync(path.join(externalPath, '.env.local'))).toBe(false);
      expect(existsSync(path.join(capturedParent, '.env.local'))).toBe(false);
    },
  );
});
