import { beforeEach, describe, expect, it, vi } from 'vitest';
const transport = vi.hoisted(() => vi.fn());
vi.mock('./auth', () => ({ githubInstallationFetch: transport }));
vi.mock('./store', () => ({ upsertGitHubIssue: vi.fn() }));
import { reviewGitHubPullRequest } from './actions';
beforeEach(() => { transport.mockReset(); transport.mockResolvedValue({ response: Response.json({ id: 1 }) }); });
describe('commit-bound review transport', () => {
  it('sends the selected commit to GitHub through the existing broker', async () => {
    await reviewGitHubPullRequest('example/repo', 7, { event: 'APPROVE', body: 'Reviewed', commitSha: 'a'.repeat(40) });
    const [repo, path, init] = transport.mock.calls[0];
    expect(repo).toBe('example/repo'); expect(path).toBe('/repos/example/repo/pulls/7/reviews');
    expect(JSON.parse(init.body)).toEqual({ event: 'APPROVE', body: 'Reviewed', commit_id: 'a'.repeat(40) });
  });
  it('preserves the existing contract for callers without a selected commit', async () => {
    await reviewGitHubPullRequest('example/repo', 7, { event: 'COMMENT', body: 'Feedback' });
    expect(JSON.parse(transport.mock.calls[0][2].body)).toEqual({ event: 'COMMENT', body: 'Feedback' });
  });
});
