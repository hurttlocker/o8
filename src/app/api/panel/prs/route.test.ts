import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { ensureGitHubPullRequests } = vi.hoisted(() => ({
  ensureGitHubPullRequests: vi.fn(async () => ({
    prs: [],
    error: null,
    stale: false,
  })),
}));

vi.mock('@/lib/github-broker', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/github-broker')>(),
  ensureGitHubPullRequests,
}));

import { GET } from './route';

const tempDirs: string[] = [];

afterEach(() => {
  ensureGitHubPullRequests.mockClear();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function transientRepo(remote?: string): string {
  const repoPath = mkdtempSync(path.join(tmpdir(), 'o8-pr-route-'));
  tempDirs.push(repoPath);
  execFileSync('git', ['init', '--quiet', repoPath]);
  if (remote) execFileSync('git', ['-C', repoPath, 'remote', 'add', 'origin', remote]);
  return repoPath;
}

describe('GET /api/panel/prs transient repos', () => {
  it('resolves an unregistered local repo through its GitHub origin', async () => {
    const repoPath = transientRepo('git@github.com:example/transient.git');
    const response = await GET(new Request(
      `http://localhost/api/panel/prs?repo=transient&repoPath=${encodeURIComponent(repoPath)}`,
    ));

    expect(response.status).toBe(200);
    expect(ensureGitHubPullRequests).toHaveBeenCalledWith('example/transient');
  });

  it('returns an empty available response when a transient repo has no GitHub origin', async () => {
    const repoPath = transientRepo();
    const response = await GET(new Request(
      `http://localhost/api/panel/prs?repo=local-only&repoPath=${encodeURIComponent(repoPath)}`,
    ));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ prs: [], repo: null, unavailable: true });
    expect(ensureGitHubPullRequests).not.toHaveBeenCalled();
  });
});
