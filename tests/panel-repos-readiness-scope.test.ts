import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import type { RepoRegistryEntry } from '@/lib/repos/types';

const previousHome = process.env.HOME;
const previousDataDir = process.env.CORTEX_IDE_DATA_DIR;
const previousO8DataDir = process.env.O8_DATA_DIR;
const home = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'o8-repo-list-scope-')));
const dataDir = path.join(home, '.o8-data');
const existingPath = path.join(home, 'existing-repo');
const missingPath = path.join(home, 'missing-repo');
const neverExistingPath = path.join(home, 'never-existing-repo');
const outsidePath = path.join(home, 'outside-repo');
const escapedSymlinkPath = path.join(existingPath, 'escaped-repo');
const externalWorktreePath = path.join(home, 'external-worktree');
process.env.HOME = home;
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_DATA_DIR = dataDir;
mkdirSync(dataDir, { recursive: true });
mkdirSync(existingPath, { recursive: true });
writeFileSync(path.join(existingPath, 'README.md'), 'registered repository\n');
execFileSync('git', ['init', '-q', '-b', 'main', existingPath]);
execFileSync('git', ['-C', existingPath, 'add', 'README.md']);
execFileSync('git', [
  '-C',
  existingPath,
  '-c',
  'user.name=o8 test',
  '-c',
  'user.email=test@o8.local',
  'commit',
  '-qm',
  'test: seed repository',
]);
execFileSync('git', ['-C', existingPath, 'worktree', 'add', '-q', '-b', 'restore-fixture', externalWorktreePath]);
mkdirSync(outsidePath, { recursive: true });
symlinkSync(outsidePath, escapedSymlinkPath, 'dir');

function repo(id: string, localPath: string): RepoRegistryEntry {
  return {
    id,
    name: id,
    localPath,
    remoteUrl: null,
    defaultBranch: 'main',
    isGitRepo: true,
    addedAt: new Date(0).toISOString(),
    lastOpenedAt: null,
    storagePressureParkingDisabled: false,
    setup: {
      envMode: 'skip',
      envFiles: [],
      installCommand: null,
      installOnCreateWorkspace: false,
      buildCommand: null,
      runBuildOnCreateWorkspace: false,
      devCommand: 'npm run dev',
      defaultPort: null,
      workspaceIsolationPreference: 'auto',
    },
  };
}

writeFileSync(path.join(dataDir, 'repos.json'), JSON.stringify({
  version: 1,
  repos: [
    ...Array.from({ length: 1_000 }, (_, index) => repo(`existing-${index}`, existingPath)),
    repo('missing', missingPath),
  ],
}));

const reposRoute = await import('@/app/api/panel/repos/route');

afterAll(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousDataDir === undefined) delete process.env.CORTEX_IDE_DATA_DIR;
  else process.env.CORTEX_IDE_DATA_DIR = previousDataDir;
  if (previousO8DataDir === undefined) delete process.env.O8_DATA_DIR;
  else process.env.O8_DATA_DIR = previousO8DataDir;
});

async function getRepos(query = '') {
  const response = await reposRoute.GET(new Request(`http://127.0.0.1/api/panel/repos${query}`));
  const data = await response.json() as {
    repos?: RepoRegistryEntry[];
    validatedRestorePaths?: Array<{ requestedPath: string; canonicalPath: string }>;
    error?: string;
  };
  return { response, data };
}

describe('GET /api/panel/repos readiness scope', () => {
  it('keeps fleet discovery cheap and leaves uncached readiness unprobed', async () => {
    const { response, data } = await getRepos();

    expect(response.status).toBe(200);
    expect(data.repos).toHaveLength(1_001);
    expect(data.repos?.every((entry) => entry.readiness === undefined)).toBe(true);
    expect(data.repos?.find((entry) => entry.id === 'existing-0')).toMatchObject({ exists: true });
    expect(data.repos?.find((entry) => entry.id === 'missing')).toMatchObject({ exists: false });
    const timing = response.headers.get('Server-Timing') ?? '';
    expect(timing).toContain('readiness;dur=');
    const totalMs = Number(timing.match(/total;dur=([0-9.]+)/)?.[1]);
    expect(totalMs).toBeLessThan(1_500);
  });

  it('probes only the selected repository and reuses that result on discovery', async () => {
    await getRepos('?readiness=missing');
    const { data } = await getRepos();

    expect(data.repos?.find((entry) => entry.id === 'missing')?.readiness?.state).toBe('missing');
    expect(data.repos?.find((entry) => entry.id === 'existing-0')?.readiness).toBeUndefined();
  });

  it('refreshes the selected repository instead of trusting a stale cache entry', async () => {
    await getRepos('?readiness=missing');
    mkdirSync(missingPath, { recursive: true });

    const { data } = await getRepos('?readiness=missing');

    expect(data.repos?.find((entry) => entry.id === 'missing')?.readiness?.state).not.toBe('missing');
  });

  it('rejects an unknown readiness target', async () => {
    const { response, data } = await getRepos('?readiness=not-registered');

    expect(response.status).toBe(404);
    expect(data.error).toBe('Registered repository not found.');
  });

  it('canonicalizes restored paths and rejects symlink escapes and missing paths', async () => {
    const query = new URLSearchParams();
    query.append('restorePath', existingPath);
    query.append('restorePath', externalWorktreePath);
    query.append('restorePath', escapedSymlinkPath);
    query.append('restorePath', outsidePath);
    query.append('restorePath', neverExistingPath);

    const { response, data } = await getRepos(`?${query.toString()}`);

    expect(response.status).toBe(200);
    expect(data.validatedRestorePaths).toEqual([
      {
        requestedPath: existingPath,
        canonicalPath: realpathSync(existingPath),
      },
      {
        requestedPath: externalWorktreePath,
        canonicalPath: realpathSync(externalWorktreePath),
      },
    ]);
  });
});
