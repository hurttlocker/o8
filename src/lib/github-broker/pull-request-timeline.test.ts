import { beforeEach, describe, expect, it, vi } from 'vitest';

const { githubInstallationFetch } = vi.hoisted(() => ({ githubInstallationFetch: vi.fn() }));
vi.mock('./auth', () => ({ githubInstallationFetch }));
import { fetchPullRequestTimelinePage } from './pull-request-timeline';
beforeEach(() => vi.clearAllMocks());

describe('pull request timeline', () => {
  it('uses the existing broker and preserves chronological activity, commit links and pagination', async () => {
    githubInstallationFetch.mockResolvedValue({ response: Response.json([
      { event: 'committed', sha: 'abcdef0123', message: 'Update the sidebar\n\nMore detail', author: { name: 'Contributor', date: '2026-10-07T10:00:00Z' } },
      { event: 'commented', id: 7, user: { login: 'reviewer', avatar_url: 'https://avatars.githubusercontent.com/u/1' }, body: 'Looks good', created_at: '2026-10-07T11:00:00Z', html_url: 'https://github.com/example/repo/pull/3#issuecomment-7' },
      { event: 'reviewed', id: 8, state: 'changes_requested', actor: { login: 'reviewer' }, submitted_at: '2026-10-07T12:00:00Z' },
    ], { headers: { link: '<https://api.github.com/page=2>; rel="next", <https://api.github.com/page=3>; rel="last"' } }) });
    const signal = new AbortController().signal;
    const result = await fetchPullRequestTimelinePage('example/repo', 3, 1, signal);
    expect(githubInstallationFetch).toHaveBeenCalledWith('example/repo', '/repos/example/repo/issues/3/timeline?per_page=100&page=1', { signal });
    expect(result.nextPage).toBe(2);
    expect(result.events).toMatchObject([
      { kind: 'committed', title: 'Update the sidebar', actor: 'Contributor', at: '2026-10-07T10:00:00Z', url: 'https://github.com/example/repo/commit/abcdef0123', commitSha: 'abcdef0123' },
      { kind: 'commented', body: 'Looks good', actor: 'reviewer', avatarUrl: 'https://avatars.githubusercontent.com/u/1' },
      { kind: 'reviewed', title: 'requested changes', at: '2026-10-07T12:00:00Z' },
    ]);
  });
  it('reports failed reads and leaves an empty final page honest', async () => {
    githubInstallationFetch.mockResolvedValueOnce({ response: Response.json({ message: 'Private routing details' }, { status: 403 }) });
    await expect(fetchPullRequestTimelinePage('example/repo', 3, 1)).rejects.toThrow('could not be loaded (403)');
    githubInstallationFetch.mockResolvedValueOnce({ response: Response.json([]) });
    expect(await fetchPullRequestTimelinePage('example/repo', 3, 2)).toEqual({ events: [], nextPage: null });
  });
});
