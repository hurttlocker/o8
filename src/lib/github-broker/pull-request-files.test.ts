import { describe, expect, it, vi } from 'vitest';
const { githubInstallationFetch } = vi.hoisted(() => ({ githubInstallationFetch: vi.fn() }));
vi.mock('./auth', () => ({ githubInstallationFetch }));
import { fetchGitHubPullRequestDetail } from './details';

describe('revision-bound pull request reads', () => {
  it('reuses a diff only after fresh authorization and invalidates equal-count head/base changes and another installation', async () => {
    let head = 'head-a'; let base = 'base-a'; let installationId = 101;
    let reads = 0; let failAuthorization = false;
    githubInstallationFetch.mockImplementation(async (_repo: string, path: string) => {
      if (path.endsWith('/pulls/801')) {
        if (failAuthorization) throw new Error('Access revoked');
        return { installation: { id: installationId }, response: Response.json({ number: 801, head: { sha: head }, base: { sha: base }, additions: 1, deletions: 1 }) };
      }
      if (path.includes('/files?')) { reads++; return { response: Response.json([{ filename: 'app.ts', additions: 1, deletions: 1, patch: `${head}:${base}:${installationId}` }]) }; }
      return { response: Response.json(path.includes('check-runs') ? { check_runs: [] } : []) };
    });
    const read = () => fetchGitHubPullRequestDetail('example/cache-scope', 801);
    await read(); await read(); expect(reads).toBe(1);
    head = 'head-b'; expect((await read()).files[0].patch).toBe('head-b:base-a:101');
    base = 'base-b'; expect((await read()).files[0].patch).toBe('head-b:base-b:101');
    installationId = 102; await read(); expect(reads).toBe(4);
    failAuthorization = true; await expect(read()).rejects.toThrow('Access revoked'); expect(reads).toBe(4);
  });
  it('releases a failed diff read for an explicit retry', async () => {
    let attempts = 0;
    githubInstallationFetch.mockImplementation(async (_repo: string, path: string) => {
      if (path.endsWith('/pulls/802')) return { installation: { id: 103 }, response: Response.json({ number: 802, head: { sha: 'h' }, base: { sha: 'b' } }) };
      if (path.includes('/files?')) { if (++attempts === 1) throw new DOMException('Interrupted', 'AbortError'); return { response: Response.json([{ filename: 'fresh.ts' }]) }; }
      return { response: Response.json(path.includes('check-runs') ? { check_runs: [] } : []) };
    });
    await expect(fetchGitHubPullRequestDetail('example/cache-scope', 802)).rejects.toThrow('Interrupted');
    expect((await fetchGitHubPullRequestDetail('example/cache-scope', 802)).files[0].path).toBe('fresh.ts');
    expect(attempts).toBe(2);
  });
});
