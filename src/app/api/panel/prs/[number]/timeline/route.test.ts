import { beforeEach, describe, expect, it, vi } from 'vitest';
const { resolveRepoSlug, fetchPullRequestTimelinePage } = vi.hoisted(() => ({ resolveRepoSlug: vi.fn(), fetchPullRequestTimelinePage: vi.fn() }));
vi.mock('@/lib/github-broker', () => ({ DEFAULT_GITHUB_REPO: '', resolveRepoSlug }));
vi.mock('@/lib/github-broker/pull-request-timeline', () => ({ fetchPullRequestTimelinePage }));
import { GET } from './route';
beforeEach(() => { vi.clearAllMocks(); resolveRepoSlug.mockResolvedValue('example/repo'); });
describe('connected pull request activity entry point', () => {
  it('resolves repository scope and passes the requested page and cancellation signal to the broker', async () => {
    fetchPullRequestTimelinePage.mockResolvedValue({ events: [], nextPage: 3 });
    const request = new Request('http://localhost/api/panel/prs/8/timeline?repo=workspace&page=2');
    const response = await GET(request, { params: Promise.resolve({ number: '8' }) });
    expect(await response.json()).toEqual({ events: [], nextPage: 3 });
    expect(resolveRepoSlug).toHaveBeenCalledWith('workspace', '');
    expect(fetchPullRequestTimelinePage).toHaveBeenCalledWith('example/repo', 8, 2, request.signal);
  });
  it.each([['8tail', '1'], ['0', '1'], ['8', '0'], ['8', '1.5']])('rejects invalid selection %s page %s', async (number, page) => {
    expect((await GET(new Request(`http://localhost/api/panel/prs/${number}/timeline?page=${page}`), { params: Promise.resolve({ number }) })).status).toBe(400);
    expect(fetchPullRequestTimelinePage).not.toHaveBeenCalled();
  });
  it('keeps connection internals out of the error surface', async () => {
    fetchPullRequestTimelinePage.mockRejectedValue(new Error('Private routing details'));
    const response = await GET(new Request('http://localhost/api/panel/prs/8/timeline'), { params: Promise.resolve({ number: '8' }) });
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain('Private routing');
  });
});
