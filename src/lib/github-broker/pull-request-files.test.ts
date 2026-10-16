import { describe, expect, it, vi } from 'vitest';
const { githubInstallationFetch } = vi.hoisted(() => ({ githubInstallationFetch: vi.fn() }));
vi.mock('./auth', () => ({ githubInstallationFetch }));
import { fetchGitHubPullRequestDetail } from './details';
import { readPullRequestFiles } from './pull-request-files';
import { readPullRequestChecks } from './pull-request-checks';
import { githubCredentialScope } from './request-budget';

describe('revision-bound pull request reads', () => {
  it('reuses a diff only after fresh authorization and invalidates equal-count head/base changes and another installation', async () => {
    let head = 'head-a'; let base = 'base-a'; let installationId = 101;
    let reads = 0; let failAuthorization = false;
    githubInstallationFetch.mockImplementation(async (_repo: string, path: string) => {
      if (path.endsWith('/pulls/801')) {
        if (failAuthorization) throw new Error('Access revoked');
        return { scope: 'fixture-files', installation: { id: installationId }, response: Response.json({ number: 801, head: { sha: head }, base: { sha: base }, additions: 1, deletions: 1 }) };
      }
      if (path.includes('/files?')) { reads++; return { scope: 'fixture-files', installation: { id: installationId }, response: Response.json([{ filename: 'app.ts', additions: 1, deletions: 1, patch: `${head}:${base}:${installationId}` }]) }; }
      return { scope: 'fixture-files', installation: { id: installationId }, response: Response.json(path.includes('check-runs') ? { check_runs: [] } : []) };
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
      if (path.endsWith('/pulls/802')) return { scope: 'fixture-files', installation: { id: 103 }, response: Response.json({ number: 802, head: { sha: 'h' }, base: { sha: 'b' } }) };
      if (path.includes('/files?')) { if (++attempts === 1) throw new DOMException('Interrupted', 'AbortError'); return { scope: 'fixture-files', installation: { id: 103 }, response: Response.json([{ filename: 'fresh.ts' }]) }; }
      return { scope: 'fixture-files', installation: { id: 103 }, response: Response.json(path.includes('check-runs') ? { check_runs: [] } : []) };
    });
    await expect(fetchGitHubPullRequestDetail('example/cache-scope', 802)).rejects.toThrow('Interrupted');
    expect((await fetchGitHubPullRequestDetail('example/cache-scope', 802)).files[0].path).toBe('fresh.ts');
    expect(attempts).toBe(2);
  });
  it('isolates identical heads across hosts and rotated credentials, including in-flight checks', async () => {
    const a = githubCredentialScope('https://host-a.test', 901, 'token-a');
    const b = githubCredentialScope('https://host-b.test', 901, 'token-a');
    let scope = a;
    githubInstallationFetch.mockImplementation(async () => ({ scope, installation: { id: 901 }, response: Response.json([{ filename: scope }]) }));
    expect((await readPullRequestFiles('example/hosts', 803, 901, 'same', 'base', 'interactive', a))[0].filename).toBe(a);
    scope = b;
    expect((await readPullRequestFiles('example/hosts', 803, 901, 'same', 'base', 'interactive', b))[0].filename).toBe(b);
    let finish!: (value: unknown) => void;
    githubInstallationFetch.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const first = readPullRequestChecks('example/rotated', 'same', 901, 'interactive', a);
    const rotated = githubCredentialScope('https://host-a.test', 901, 'token-b');
    githubInstallationFetch.mockImplementation(async () => ({ scope: rotated, installation: { id: 901 }, response: Response.json({ check_runs: [{ name: 'new-credential' }] }) }));
    expect((await readPullRequestChecks('example/rotated', 'same', 901, 'interactive', rotated))[0].name).toBe('new-credential');
    finish({ scope: rotated, installation: { id: 901 }, response: Response.json({ check_runs: [{ name: 'old-request' }] }) });
    await expect(first).rejects.toThrow('authorization changed');
  });
});
