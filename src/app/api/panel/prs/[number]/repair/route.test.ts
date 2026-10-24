import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ github: vi.fn(), repos: vi.fn(), lanes: vi.fn() }));
vi.mock('@/lib/github-broker/auth', () => ({ githubInstallationFetch: f.github }));
vi.mock('@/lib/repos/registry', () => ({ listRepos: f.repos }));
vi.mock('@/lib/lane/registry', () => ({ listLanes: f.lanes }));
vi.mock('@/lib/orchestrator/control-plane', () => ({ readOrchestratorControlPlaneState: () => ({ packets: [] }) }));
import { GET, POST } from './route';
import { getOrCreateWsToken } from '@/lib/ws-auth';
import { getOrCreateLocalWorkerToken } from '@/lib/auth/worker-token';
const sha = 'a'.repeat(40);
const context = { params: Promise.resolve({ number: '7' }) };
function request(body?: unknown, authenticated = true) {
  return new NextRequest('http://localhost/api/panel/prs/7/repair?repo=fixture%2Frepo', {
    method: body ? 'POST' : 'GET', headers: authenticated ? { authorization: `Bearer ${getOrCreateWsToken()}` } : {},
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  f.repos.mockResolvedValue([{ localPath: '/fixture', remoteUrl: 'git@github.com:fixture/repo.git' }]);
  f.lanes.mockReturnValue([]);
  f.github.mockImplementation(async (_repo, path) => ({ scope: 'fixture-scope', response: Response.json(
    path.includes('/pulls/') ? { state: 'open', head: { sha, ref: 'fix-ci' }, base: { ref: 'main' } }
      : path.includes('/check-runs') ? { check_runs: [
        { id: 1, name: 'Tests', status: 'completed', conclusion: 'failure', html_url: 'https://github.com/fixture/repo/actions/runs/10/job/20' },
        { id: 2, name: 'Skipped', status: 'completed', conclusion: 'skipped' },
      ] } : { head_sha: sha, name: 'Tests', workflow_name: 'CI' }
  ) }));
});
describe('operator PR repair preparation', () => {
  it('denies anonymous callers before reading repository or GitHub data', async () => {
    expect((await GET(request(undefined, false), context)).status).toBe(403);
    expect((await POST(request({ expectedHeadSha: sha, checks: ['1'] }, false), context)).status).toBe(403);
    expect(f.github).not.toHaveBeenCalled();
  });
  it('offers only fresh canonical failed checks with their exact head', async () => {
    const response = await GET(request(), context);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toMatchObject({ headSha: sha, branch: 'fix-ci', checks: [{ key: '1', name: 'Tests' }] });
    expect(data.checks).toHaveLength(1);
  });
  it('builds normal editable delegation input with bounded selected job logs', async () => {
    const prior = f.github.getMockImplementation()!;
    f.github.mockImplementation(async (repo, path, init) => path.endsWith('/logs')
      ? { scope: 'fixture-scope', response: new Response('failed assertion\n'.repeat(50_000)) }
      : prior(repo, path, init));
    const response = await POST(request({ expectedHeadSha: sha, checks: ['1'], clientMutationId: 'fixture-repair' }), context);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.delegation).toMatchObject({ repoPath: '/fixture', readOnly: false, repairPullRequest: 7, expectedRepairHeadSha: sha, clientMutationId: 'fixture-repair' });
    expect(data.delegation.prompt).toContain('failed assertion');
    expect(data.delegation.prompt).toContain('workflow: CI');
    expect(data.delegation.prompt.length).toBeLessThanOrEqual(24_000);
    expect(data.delegation).not.toHaveProperty('runtime');
  });
  it('refuses a newer head before fetching job logs or preparing a launch', async () => {
    const response = await POST(request({ expectedHeadSha: 'b'.repeat(40), checks: ['1'], clientMutationId: 'stale' }), context);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'stale_pr_head' });
    expect(f.github.mock.calls.every(call => !call[1].includes('/jobs/'))).toBe(true);
  });
  it('defers to the durable PR owner instead of preparing another worker', async () => {
    f.lanes.mockReturnValue([{ id: 'lane-owner', repoPath: '/fixture', prNumber: 7, status: 'paused', label: 'Existing worker', packetId: 'pkt-existing' }]);
    const response = await POST(request({ expectedHeadSha: sha, checks: ['1'], clientMutationId: 'owned' }), context);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'pr_has_owner', ownerLaneId: 'lane-owner' });
  });
  it('refuses fabricated or no-longer-failing check identities', async () => {
    expect((await POST(request({ expectedHeadSha: sha, checks: ['2'], clientMutationId: 'invalid' }), context)).status).toBe(409);
  });
  it('refuses an authorization change during the check read', async () => {
    const prior = f.github.getMockImplementation()!;
    f.github.mockImplementation(async (...args) => ({ ...await prior(...args), scope: args[1].includes('/check-runs') ? 'changed' : 'fixture-scope' }));
    expect((await GET(request(), context)).status).toBe(502);
  });
  it('denies a real worker credential even on loopback', async () => {
    const req = new NextRequest('http://localhost/api/panel/prs/7/repair?repo=fixture%2Frepo', {
      headers: { authorization: `Bearer ${getOrCreateLocalWorkerToken()}` },
    });
    expect((await GET(req, context)).status).toBe(403); expect(f.github).not.toHaveBeenCalled();
  });
  it('uses a signed log redirect without forwarding the GitHub credential', async () => {
    const prior = f.github.getMockImplementation()!;
    f.github.mockImplementation(async (...args) => args[1].endsWith('/logs')
      ? { scope: 'fixture-scope', response: new Response(null, { status: 302, headers: { location: 'https://fixture.blob.core.windows.net/logs/signed' } }) }
      : prior(...args));
    const download = vi.fn(async (_url: URL, _init: RequestInit) => new Response('signed fixture failure'));
    vi.stubGlobal('fetch', download);
    try {
      const response = await POST(request({ expectedHeadSha: sha, checks: ['1'], clientMutationId: 'signed' }), context);
      expect(response.status).toBe(200);
      expect((await response.json()).delegation.prompt).toContain('signed fixture failure');
      expect(download).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({ redirect: 'error' }));
      expect(download.mock.calls[0][1]).not.toHaveProperty('headers');
    } finally { vi.unstubAllGlobals(); }
  });
  it('refuses off-host log redirects and jobs from a different commit', async () => {
    const prior = f.github.getMockImplementation()!;
    f.github.mockImplementation(async (...args) => args[1].endsWith('/logs')
      ? { scope: 'fixture-scope', response: new Response(null, { status: 302, headers: { location: 'https://example.invalid/log' } }) }
      : prior(...args));
    const download = vi.fn(); vi.stubGlobal('fetch', download);
    try {
      const body = { expectedHeadSha: sha, checks: ['1'], clientMutationId: 'bad-logs' };
      expect((await POST(request(body), context)).status).toBe(502); expect(download).not.toHaveBeenCalled();
      f.github.mockImplementation(async (...args) => args[1].includes('/jobs/')
        ? { scope: 'fixture-scope', response: Response.json({ head_sha: 'b'.repeat(40) }) } : prior(...args));
      expect((await POST(request(body), context)).status).toBe(502); expect(download).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });
  it('keeps check evidence with a truthful note when logs are unavailable', async () => {
    const prior = f.github.getMockImplementation()!;
    f.github.mockImplementation(async (...args) => args[1].endsWith('/logs')
      ? { scope: 'fixture-scope', response: new Response(null, { status: 404 }) } : prior(...args));
    const response = await POST(request({ expectedHeadSha: sha, checks: ['1'], clientMutationId: 'no-logs' }), context);
    expect(response.status).toBe(200);
    expect((await response.json()).delegation.prompt).toContain('Job logs unavailable');
  });
  it('rejects an over-budget or duplicate selection before any GitHub reads', async () => {
    for (const checks of [Array.from({ length: 13 }, (_, i) => String(i)), ['1', '1']]) {
      expect((await POST(request({ expectedHeadSha: sha, checks, clientMutationId: 'invalid-selection' }), context)).status).toBe(400);
    }
    expect(f.github).not.toHaveBeenCalled();
  });

});
