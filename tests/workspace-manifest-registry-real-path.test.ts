import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

const root = mkdtempSync(path.join(os.tmpdir(), 'o8-workspace-manifest-registry-'));
const dataDir = path.join(root, 'data');
const previousDataDir = process.env.CORTEX_IDE_DATA_DIR;
mkdirSync(dataDir);
process.env.CORTEX_IDE_DATA_DIR = dataDir;

function fixture(name: string, manifest: unknown): string {
  const repoPath = path.join(root, name);
  mkdirSync(repoPath);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoPath });
  execFileSync('git', ['config', 'user.name', 'o8-test'], { cwd: repoPath });
  execFileSync('git', ['config', 'user.email', 'test@invalid'], { cwd: repoPath });
  writeFileSync(
    path.join(repoPath, 'o8.workspace.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  execFileSync('git', ['add', 'o8.workspace.json'], { cwd: repoPath });
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: repoPath });
  return repoPath;
}

const { addRepo, listRepos } = await import('@/lib/repos/registry');

afterAll(() => {
  if (previousDataDir === undefined) delete process.env.CORTEX_IDE_DATA_DIR;
  else process.env.CORTEX_IDE_DATA_DIR = previousDataDir;
  rmSync(root, { recursive: true, force: true });
});

describe('workspace manifest repository-connect path', () => {
  it('caches the checked-in manifest summary through addRepo and persisted readback', async () => {
    const repoPath = fixture('valid-repo', {
      version: 1,
      services: [
        { name: 'api', command: 'npm run api' },
        { name: 'web', command: 'npm run web' },
      ],
    });

    const entry = await addRepo(repoPath);
    const expected = {
      version: 1,
      path: path.join(entry.localPath, 'o8.workspace.json'),
      serviceNames: ['api', 'web'],
    };
    expect(entry.manifest).toEqual(expected);
    expect((await listRepos()).find((repo) => repo.id === entry.id)?.manifest).toEqual(expected);

    const persisted = JSON.parse(readFileSync(path.join(dataDir, 'repos.json'), 'utf8')) as {
      repos: Array<{ id: string; manifest?: unknown }>;
    };
    expect(persisted.repos.find((repo) => repo.id === entry.id)?.manifest).toEqual(expected);
  });

  it('records an invalid manifest without blocking addRepo', async () => {
    const repoPath = fixture('invalid-repo', { version: 1, launch: 'npm start' });

    const entry = await addRepo(repoPath);

    expect(entry.manifest).toEqual({
      error: expect.stringContaining('$.launch: unknown key'),
    });
  });
});
