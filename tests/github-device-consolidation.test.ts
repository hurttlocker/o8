import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  execFileSync: vi.fn(() => ''),
  fetchGitHubUser: vi.fn(async () => ({
    id: 42,
    login: 'octocat',
    name: 'Octo Cat',
    email: 'octo@example.com',
    avatar_url: 'https://github.com/octocat.png',
  })),
  fetchGitHubEmail: vi.fn(async () => 'octo@example.com'),
  findOrCreateByGithub: vi.fn(() => ({
    id: 'user-42',
    name: 'Octo Cat',
    email: 'octo@example.com',
    avatarUrl: 'https://github.com/octocat.png',
    plan: 'free',
  })),
  signToken: vi.fn(async () => 'signed-o8-token'),
  createSession: vi.fn(),
  resolveRequestPrincipal: vi.fn(() => 'operator'),
}));

vi.mock('node:child_process', () => ({ execFileSync: mocks.execFileSync }));
vi.mock('@/lib/auth/github', () => ({
  fetchGitHubUser: mocks.fetchGitHubUser,
  fetchGitHubEmail: mocks.fetchGitHubEmail,
}));
vi.mock('@/lib/db/users', () => ({ findOrCreateByGithub: mocks.findOrCreateByGithub }));
vi.mock('@/lib/auth/jwt', () => ({ signToken: mocks.signToken }));
vi.mock('@/lib/db/sessions', () => ({ createSession: mocks.createSession }));
vi.mock('@/lib/auth/principal', () => ({ resolveRequestPrincipal: mocks.resolveRequestPrincipal }));

import { POST } from '@/app/api/panel/github-device/route';

function actionRequest(body: Record<string, unknown>) {
  return new Request('http://localhost/api/panel/github-device', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/panel/github-device — consolidated GitHub credential actions', () => {
  it('accepts a PAT through the device surface and creates the same local identity session', async () => {
    const response = await POST(actionRequest({ action: 'login_token', token: 'ghp_test' }));
    const body = await response.json() as { ok?: boolean; status?: string; user?: { githubUsername?: string } };

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ ok: true, status: 'complete', user: { githubUsername: 'octocat' } });
    expect(response.headers.get('set-cookie')).toContain('o8-token=signed-o8-token');
    expect(mocks.execFileSync).toHaveBeenCalledWith(
      'gh',
      ['auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--with-token'],
      expect.objectContaining({ input: 'ghp_test\n' }),
    );
    expect(mocks.findOrCreateByGithub).toHaveBeenCalledWith(42, expect.objectContaining({
      email: 'octo@example.com',
      name: 'Octo Cat',
    }));
    expect(mocks.createSession).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user-42',
      token: 'signed-o8-token',
    }));
  });

  it('disconnects gh through the device surface without minting another identity session', async () => {
    const response = await POST(actionRequest({ action: 'logout', user: 'octocat' }));
    const body = await response.json() as { ok?: boolean; status?: string };

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ ok: true, status: 'disconnected' });
    expect(mocks.execFileSync).toHaveBeenCalledWith(
      'gh',
      ['auth', 'logout', '--hostname', 'github.com', '--user', 'octocat'],
      expect.any(Object),
    );
    expect(mocks.findOrCreateByGithub).not.toHaveBeenCalled();
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  it('rejects unsupported actions instead of silently treating them as device flow', async () => {
    const response = await POST(actionRequest({ action: 'switch' }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: 'Unsupported GitHub connection action.' });
  });
});
