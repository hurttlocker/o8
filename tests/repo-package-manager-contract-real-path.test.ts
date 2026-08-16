import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';
import { dependencyInstallCommandForManager } from '@/lib/workspace/dependency-manager-contract';

const root = mkdtempSync(path.join(os.tmpdir(), 'o8-repo-package-manager-contract-'));
const dataDir = path.join(root, 'data');
const previousDataDir = process.env.CORTEX_IDE_DATA_DIR;
mkdirSync(dataDir);
process.env.CORTEX_IDE_DATA_DIR = dataDir;

function fixture(name: string, packageManager: string): string {
  const repoPath = path.join(root, name);
  mkdirSync(repoPath);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoPath });
  execFileSync('git', ['config', 'user.name', 'o8-test'], { cwd: repoPath });
  execFileSync('git', ['config', 'user.email', 'test@invalid'], { cwd: repoPath });
  writeFileSync(path.join(repoPath, 'package.json'), JSON.stringify({
    name,
    version: '1.0.0',
    private: true,
    packageManager,
  }));
  writeFileSync(path.join(repoPath, 'yarn.lock'), '# lock\n');
  execFileSync('git', ['add', 'package.json', 'yarn.lock'], { cwd: repoPath });
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: repoPath });
  return repoPath;
}

function noLockFixture(name: string, packageManager: string): string {
  const repoPath = path.join(root, name);
  mkdirSync(repoPath);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoPath });
  execFileSync('git', ['config', 'user.name', 'o8-test'], { cwd: repoPath });
  execFileSync('git', ['config', 'user.email', 'test@invalid'], { cwd: repoPath });
  writeFileSync(path.join(repoPath, 'package.json'), JSON.stringify({
    name,
    version: '1.0.0',
    private: true,
    packageManager,
  }));
  execFileSync('git', ['add', 'package.json'], { cwd: repoPath });
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: repoPath });
  return repoPath;
}

const { addRepo, listRepos, updateRepo } = await import('@/lib/repos/registry');

afterAll(() => {
  if (previousDataDir === undefined) delete process.env.CORTEX_IDE_DATA_DIR;
  else process.env.CORTEX_IDE_DATA_DIR = previousDataDir;
  rmSync(root, { recursive: true, force: true });
});

describe('registered repository package-manager contract', () => {
  it('persists Yarn Classic and Berry install flags through addRepo and readback', async () => {
    const classic = await addRepo(fixture('yarn-classic-repo', 'yarn@1.22.22'));
    const berry = await addRepo(fixture(
      'yarn-berry-repo',
      `yarn@4.6.0+sha512.${'a'.repeat(128)}`,
    ));

    expect(classic.setup.installCommand).toBe('yarn install --frozen-lockfile');
    expect(berry.setup.installCommand).toBe('yarn install --immutable');
    const reloaded = await listRepos();
    expect(reloaded.find((entry) => entry.id === classic.id)?.setup.installCommand).toBe(
      'yarn install --frozen-lockfile',
    );
    expect(reloaded.find((entry) => entry.id === berry.id)?.setup.installCommand).toBe(
      'yarn install --immutable',
    );
    const persisted = readFileSync(path.join(dataDir, 'repos.json'), 'utf8');
    expect(persisted).toContain('yarn install --frozen-lockfile');
    expect(persisted).toContain('yarn install --immutable');
  });

  it.each([
    ['npm', 'npm@11.8.0'],
    ['bun', 'bun@1.2.5'],
  ] as const)('persists no install contract for a no-lock %s repository', async (manager, declaration) => {
    expect(dependencyInstallCommandForManager(manager, declaration.split('@')[1]!, false)).toBeNull();
    const entry = await addRepo(noLockFixture(`${manager}-no-lock-repo`, declaration));

    expect(entry.setup.installCommand).toBeNull();
    expect(entry.setup.installOnCreateWorkspace).toBe(false);
    const reloaded = await listRepos();
    expect(reloaded.find((candidate) => candidate.id === entry.id)?.setup).toMatchObject({
      installCommand: null,
      installOnCreateWorkspace: false,
    });
    const persisted = JSON.parse(readFileSync(path.join(dataDir, 'repos.json'), 'utf8')) as {
      repos: Array<{ id: string; setup: { installCommand: string | null } }>;
    };
    expect(persisted.repos.find((candidate) => candidate.id === entry.id)?.setup.installCommand)
      .toBeNull();

    await updateRepo(entry.id, {
      setup: {
        ...entry.setup,
        installCommand: `${manager} install`,
        installOnCreateWorkspace: true,
      },
    });
    const reconciled = await addRepo(entry.localPath);
    expect(reconciled.setup).toMatchObject({
      installCommand: null,
      installOnCreateWorkspace: false,
    });
  });
});
