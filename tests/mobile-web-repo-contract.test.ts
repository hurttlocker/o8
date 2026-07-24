import { describe, expect, it, vi } from 'vitest';

const readRepoPathRegistry = vi.fn(async () => ({
  ok: true as const,
  repos: [
    {
      id: 'repo-o8',
      name: 'o8',
      path: '/tmp/o8',
    },
  ],
}));

vi.mock('@/lib/repos/repo-path-registry', () => ({
  readRepoPathRegistry,
}));

const { GET } = await import('@/app/api/v2/repos/route');
const { normalizeMobileRepoList } = await import('@/app/mobile/mobile-chat-repos');

describe('mobile web repository contract', () => {
  it('projects the real repository route response into Assistant repo options', async () => {
    const response = await GET();
    const payload = await response.json();

    expect(normalizeMobileRepoList(payload)).toEqual([
      {
        id: 'repo-o8',
        name: 'o8',
        localPath: '/tmp/o8',
      },
    ]);
  });
});
