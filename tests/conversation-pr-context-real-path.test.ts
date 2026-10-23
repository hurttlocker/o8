import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { createHmac } from 'node:crypto';
import { afterAll, expect, it, vi } from 'vitest';

const root = mkdtempSync(path.join(tmpdir(), 'o8-conversation-pr-context-'));
vi.stubEnv('O8_DATA_DIR', root);
vi.stubEnv('CORTEX_IDE_DATA_DIR', root);
vi.stubEnv('CORTEX_IDE_DB_PATH', path.join(root, 'context.db'));

const { closeDb } = await import('@/lib/db');
const { writePersistedLlmChat } = await import('@/lib/llm/chat-history-store');
const { getOrCreateWsToken } = await import('@/lib/ws-auth');
const { GET: historyGet } = await import('@/app/api/orchestrator/history/route');
const linksApi = await import('@/app/api/orchestrator/pull-request-context/route');
const { getSqlite } = await import('@/lib/db');
const { upsertGitHubRepository, upsertGitHubPullRequest, replaceGitHubPullRequests, getGitHubPullRequestByNumber } = await import('@/lib/github-broker/store');
const { getCanonicalChatHistoryPath, persistCanonicalChatHistoryRecord } = await import('@/lib/llm/chat-history-store');
const { createLane, updateLane, getLane, getLaneEvents } = await import('@/lib/lane/registry');
const { getOrCreateLocalWorkerToken } = await import('@/lib/auth/worker-token');
const { resolveRequestPrincipal } = await import('@/lib/auth/principal');
const { panelGateMiddleware } = await import('@/middleware');
const { DELETE: deleteHistory } = await import('@/app/api/v2/chat-history/route');

let sequence = 0;

function request(method: string, body?: unknown, query = '', token = getOrCreateWsToken()): NextRequest {
  return new NextRequest(`http://localhost/api/orchestrator/pull-request-context${query}`, {
    method, headers: { host: 'localhost', authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function mirror(repositoryId: number, repositoryFullName: string, pullRequestId: number, number = 7) {
  const [owner, name] = repositoryFullName.split('/');
  upsertGitHubRepository({ repoId: repositoryId, fullName: repositoryFullName, owner, name, private: false });
  upsertGitHubPullRequest({
    pullRequestId, repositoryId, repoFullName: repositoryFullName, number, title: 'Fixture PR', state: 'open',
    author: { login: 'fixture-owner' }, body: '', headRefName: 'shared-branch', baseRefName: 'main',
    additions: 1, deletions: 0, changedFiles: 1, reviewDecision: null, statusCheckRollup: [],
    url: `https://github.com/${repositoryFullName}/pull/${number}`,
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', closedAt: null, mergedAt: null,
  });
  return { host: 'github.com', repositoryId, pullRequestId, number };
}

function fixture() {
  sequence++;
  const threadId = `thoughts-context-${sequence}`;
  const otherThreadId = `${threadId}-unrelated`;
  for (const id of [threadId, otherThreadId]) writePersistedLlmChat(id, {
    title: id, repoPath: root, repoBranch: 'shared-branch',
    messages: [{ id: 'message', role: 'user', content: 'Preserved', timestamp: 1 }],
  });
  const first = mirror(sequence * 10 + 1, `fixture/repo-${sequence}`, sequence * 100 + 1);
  const second = mirror(sequence * 10 + 2, `fixture/other-${sequence}`, sequence * 100 + 2);
  return { threadId, otherThreadId, first, second };
}

async function history(threadId: string) {
  const response = await historyGet(new NextRequest(`http://localhost/api/orchestrator/history?threadId=${threadId}`, {
    headers: { authorization: `Bearer ${getOrCreateWsToken()}` },
  }));
  expect(response.status).toBe(200);
  return response.json();
}

afterAll(() => {
  closeDb();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

it('exposes an explicit context-link collection through persisted conversation history', async () => {
  const threadId = 'thoughts-pr-context';
  writePersistedLlmChat(threadId, {
    title: 'Context links',
    messages: [{ id: 'message', role: 'user', content: 'Keep the discussion.', timestamp: 1 }],
  });
  const response = await historyGet(new NextRequest(`http://localhost/api/orchestrator/history?threadId=${threadId}`, {
    headers: { authorization: `Bearer ${getOrCreateWsToken()}` },
  }));
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.timeline[0].content).toBe('Keep the discussion.');
  expect(body.pullRequestContext).toEqual({ links: [], nextCursor: null });
});

it('attaches idempotently, survives database reopen, and keeps same-number cross-repository links distinct', async () => {
  const f = fixture();
  const body = { threadId: f.threadId, ...f.first };
  const created = await linksApi.POST(request('POST', body));
  expect(created.status).toBe(201);
  const first = await created.json();
  expect(first.result.link).toMatchObject({ ...body, kind: 'context', source: 'operator' });
  const duplicate = await linksApi.POST(request('POST', body));
  expect(duplicate.status).toBe(200);
  expect((await duplicate.json()).result.link.id).toBe(first.result.link.id);
  expect((await linksApi.POST(request('POST', { threadId: f.threadId, ...f.second }))).status).toBe(201);
  closeDb();
  const forward = await history(f.threadId);
  expect(forward.pullRequestContext.links.map((link: { pullRequestId: number }) => link.pullRequestId))
    .toEqual([f.first.pullRequestId, f.second.pullRequestId]);
  const query = new URLSearchParams(Object.entries(f.first).map(([key, value]) => [key, String(value)]));
  const reverse = await linksApi.GET(request('GET', undefined, `?${query}`));
  expect((await reverse.json()).result.links.map((link: { threadId: string }) => link.threadId)).toEqual([f.threadId]);
  expect(getSqlite().prepare('SELECT COUNT(*) AS n FROM conversation_pr_context WHERE thread_id = ?').get(f.threadId)).toEqual({ n: 2 });
});

it.each(['upsert', 'replace'] as const)('keeps a known repository ID after a later %s omits it', async writer => {
  const f = fixture();
  const repoFullName = `fixture/repo-${sequence}`;
  const current = getGitHubPullRequestByNumber(repoFullName, f.first.number)!;
  expect(current.repositoryId).toBe(f.first.repositoryId);
  const withoutId = { ...current, title: 'Updated without repository identity' };
  delete withoutId.repositoryId;
  if (writer === 'upsert') upsertGitHubPullRequest(withoutId);
  else replaceGitHubPullRequests(repoFullName, [withoutId]);

  closeDb();
  expect(getGitHubPullRequestByNumber(repoFullName, f.first.number)).toMatchObject({
    repositoryId: f.first.repositoryId,
    title: 'Updated without repository identity',
  });
  expect(getSqlite().prepare('SELECT repository_id FROM github_pull_requests WHERE pull_request_id = ?')
    .get(f.first.pullRequestId)).toEqual({ repository_id: f.first.repositoryId });
  // The surviving mirror identity must still authorize a new explicit link
  // through the actual operator API, rather than only a direct store read.
  const attached = await linksApi.POST(request('POST', { threadId: f.threadId, ...f.first }));
  expect(attached.status).toBe(201);
  closeDb();
  expect((await history(f.threadId)).pullRequestContext.links)
    .toEqual([expect.objectContaining({ ...f.first, repositoryFullName: repoFullName })]);
});

it('retains immutable identities across rename and archive, then unlinks without changing history or primary delivery', async () => {
  const f = fixture();
  const lane = createLane({ repoPath: root, branch: 'shared-branch', runtime: 'codex', packetId: `fixture-${sequence}` });
  updateLane(lane.id, { prNumber: 99 });
  const laneBefore = getLane(lane.id);
  const eventsBefore = getLaneEvents(lane.id);
  const file = getCanonicalChatHistoryPath(f.threadId);
  const archived = { ...JSON.parse(readFileSync(file, 'utf8')), archivedAt: '2026-01-02T00:00:00Z' };
  persistCanonicalChatHistoryRecord(f.threadId, archived);
  const historyBefore = readFileSync(file, 'utf8');
  const payload = { threadId: f.threadId, ...f.first };
  expect((await linksApi.POST(request('POST', payload))).status).toBe(201);
  mirror(f.first.repositoryId, `fixture/renamed-${sequence}`, f.first.pullRequestId);
  closeDb();
  const links = (await history(f.threadId)).pullRequestContext.links;
  expect(links[0]).toMatchObject({ ...payload, repositoryFullName: `fixture/renamed-${sequence}` });
  expect(links[0].url).toBe(`https://github.com/fixture/renamed-${sequence}/pull/7`);
  expect((await history(f.otherThreadId)).pullRequestContext.links).toEqual([]);
  expect((await linksApi.DELETE(request('DELETE', payload))).status).toBe(200);
  expect((await linksApi.DELETE(request('DELETE', payload)).then(response => response.json())).result.removed).toBe(false);
  closeDb();
  expect((await history(f.threadId)).pullRequestContext.links).toEqual([]);
  expect(readFileSync(file, 'utf8')).toBe(historyBefore);
  expect(getLane(lane.id)).toEqual(laneBefore);
  expect(getLaneEvents(lane.id)).toEqual(eventsBefore);
});

it('pages forward and reverse links without duplicating same-branch conversations', async () => {
  const f = fixture();
  for (const [threadId, identity] of [[f.threadId, f.first], [f.threadId, f.second], [f.otherThreadId, f.first]] as const) {
    expect((await linksApi.POST(request('POST', { threadId, ...identity }))).status).toBe(201);
  }
  const first = await linksApi.GET(request('GET', undefined, `?threadId=${f.threadId}&limit=1`)).then(r => r.json());
  expect(first.result.links).toHaveLength(1);
  expect(first.result.nextCursor).toBe(first.result.links[0].id);
  const second = await linksApi.GET(request('GET', undefined, `?threadId=${f.threadId}&limit=1&after=${first.result.nextCursor}`)).then(r => r.json());
  expect(second.result.links[0].id).not.toBe(first.result.links[0].id);
  expect(second.result.nextCursor).toBeNull();
  const query = new URLSearchParams(Object.entries(f.first).map(([key, value]) => [key, String(value)]));
  const reverse = await linksApi.GET(request('GET', undefined, `?${query}&limit=1`)).then(r => r.json());
  const next = await linksApi.GET(request('GET', undefined, `?${query}&limit=1&after=${reverse.result.nextCursor}`)).then(r => r.json());
  expect([reverse.result.links[0].threadId, next.result.links[0].threadId]).toEqual([f.threadId, f.otherThreadId]);
});

it.each(['anonymous', 'unknown', 'worker'] as const)(
  'refuses non-operator authority on every new route method (%s)', async authority => {
    const token = authority === 'worker' ? getOrCreateLocalWorkerToken() : authority === 'unknown' ? 'unknown-token' : '';
    const f = fixture();
    expect(resolveRequestPrincipal(request('GET', undefined, '', token)))
      .toBe(authority === 'worker' ? 'worker' : 'anonymous');
    for (const handler of [linksApi.GET, linksApi.POST, linksApi.DELETE]) {
      const method = handler === linksApi.GET ? 'GET' : handler === linksApi.POST ? 'POST' : 'DELETE';
      const response = await handler(request(method, method === 'GET' ? undefined : { threadId: f.threadId, ...f.first }, '', token));
      expect(response.status).toBe(403);
      expect(panelGateMiddleware(request(method, method === 'GET' ? undefined : {}, '', token)).status).toBeGreaterThanOrEqual(400);
    }
    expect((await history(f.threadId)).pullRequestContext.links).toEqual([]);
  },
);

it('retains the default middleware gate and does not expose context to unauthenticated history reads', async () => {
  const f = fixture();
  expect(panelGateMiddleware(request('GET')).headers.get('x-middleware-next')).toBe('1');
  await linksApi.POST(request('POST', { threadId: f.threadId, ...f.first }));
  const response = await historyGet(new NextRequest(`http://localhost/api/orchestrator/history?threadId=${f.threadId}`, {
    headers: { host: 'localhost' },
  }));
  expect(response.status).toBe(200);
  expect((await response.json()).pullRequestContext).toBeUndefined();
});

it('refuses wrong identities, invalid threads and malformed requests without persistence or network actions', async () => {
  const f = fixture();
  const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network action'));
  try {
    for (const override of [{ repositoryId: f.second.repositoryId }, { pullRequestId: f.second.pullRequestId }, { number: 8 }]) {
      const response = await linksApi.POST(request('POST', { threadId: f.threadId, ...f.first, ...override }));
      expect(response.status).toBe(409);
    }
    for (const override of [{ host: 'other.example' }, { number: 1.5 }, { repositoryId: -1 }, { threadId: '../escape' }]) {
      expect((await linksApi.POST(request('POST', { threadId: f.threadId, ...f.first, ...override }))).status).toBe(400);
    }
    expect((await linksApi.POST(request('POST', { threadId: 'thoughts-missing', ...f.first }))).status).toBe(404);
    expect((await linksApi.GET(request('GET', undefined, `?threadId=${f.threadId}&after=no`))).status).toBe(400);
    expect((await linksApi.GET(request('GET', undefined, `?threadId=${f.threadId}&repositoryId=1`))).status).toBe(400);
    const malformed = new NextRequest('http://localhost/api/orchestrator/pull-request-context', {
      method: 'POST', headers: { authorization: `Bearer ${getOrCreateWsToken()}` }, body: '{',
    });
    expect((await linksApi.POST(malformed)).status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
    expect((await history(f.threadId)).pullRequestContext.links).toEqual([]);
  } finally { fetch.mockRestore(); }
});

it('refuses stale-name reuse and requires provider repository identity instead of a current name join', async () => {
  const f = fixture();
  const oldName = `repo-${sequence}`;
  upsertGitHubRepository({ repoId: f.first.repositoryId, fullName: `fixture/renamed-${sequence}`,
    owner: 'fixture', name: `renamed-${sequence}`, private: false });
  upsertGitHubRepository({ repoId: f.first.repositoryId + 2, fullName: `fixture/${oldName}`,
    owner: 'fixture', name: oldName, private: false });
  const staleName = await linksApi.POST(request('POST', {
    threadId: f.threadId, ...f.first, repositoryId: f.first.repositoryId + 2,
  }));
  expect(staleName.status).toBe(409);
  expect((await linksApi.POST(request('POST', { threadId: f.threadId, ...f.first }))).status).toBe(201);
  const links = (await history(f.threadId)).pullRequestContext.links;
  expect(links[0].repositoryId).toBe(f.first.repositoryId);
  mirror(f.first.repositoryId, `fixture/renamed-${sequence}`, f.first.pullRequestId);
  expect((await history(f.threadId)).pullRequestContext.links[0].repositoryFullName).toBe(`fixture/renamed-${sequence}`);
});

it('allows unlink after the real conversation deletion entry point and stale mirror removal', async () => {
  const f = fixture();
  const payload = { threadId: f.threadId, ...f.first };
  await linksApi.POST(request('POST', payload));
  const response = await deleteHistory(new NextRequest(`http://localhost/api/v2/chat-history?tabId=${f.threadId}`, {
    method: 'DELETE', headers: { authorization: `Bearer ${getOrCreateWsToken()}` },
  }));
  expect(response.status).toBe(200);
  getSqlite().prepare('DELETE FROM github_pull_requests WHERE pull_request_id = ?').run(f.first.pullRequestId);
  const removed = await linksApi.DELETE(request('DELETE', payload));
  expect(removed.status).toBe(200);
  expect((await removed.json()).result.removed).toBe(true);
});

it('refuses legacy mirror rows without immutable repository evidence after reopening the database', async () => {
  const f = fixture();
  getSqlite().prepare('UPDATE github_pull_requests SET repository_id = NULL WHERE pull_request_id = ?').run(f.first.pullRequestId);
  closeDb();
  expect((await linksApi.POST(request('POST', { threadId: f.threadId, ...f.first }))).status).toBe(409);
});

it('does not treat an enterprise mirror with matching numeric IDs as a GitHub.com PR', async () => {
  const f = fixture();
  expect((await linksApi.POST(request('POST', { threadId: f.threadId, ...f.first }))).status).toBe(201);
  getSqlite().prepare('UPDATE github_pull_requests SET url = ? WHERE pull_request_id = ?')
    .run(`https://enterprise.example/fixture/repo-${sequence}/pull/7`, f.first.pullRequestId);
  expect((await linksApi.POST(request('POST', { threadId: f.threadId, ...f.first }))).status).toBe(409);
  expect((await history(f.threadId)).pullRequestContext.links[0].url)
    .toBe(`https://github.com/fixture/repo-${sequence}/pull/7`);
});

it('ignores a hostless repository-name cache collision for new and existing GitHub.com links', async () => {
  const f = fixture();
  const payload = { threadId: f.threadId, ...f.first };
  await linksApi.POST(request('POST', payload));
  upsertGitHubRepository({ repoId: f.first.repositoryId, fullName: `enterprise/colliding-${sequence}`,
    owner: 'enterprise', name: `colliding-${sequence}`, private: true });
  const expected = `https://github.com/fixture/repo-${sequence}/pull/7`;
  expect((await history(f.threadId)).pullRequestContext.links[0].url).toBe(expected);
  const response = await linksApi.POST(request('POST', { threadId: f.otherThreadId, ...f.first }));
  expect(response.status).toBe(201);
  expect((await response.json()).result.link.url).toBe(expected);
});

it('pins signed webhook repository identity before an operator attaches the PR', async () => {
  const f = fixture();
  vi.stubEnv('GITHUB_APP_PRIVATE_KEY', 'fixture-not-used-for-signing');
  vi.stubEnv('GITHUB_APP_WEBHOOK_SECRET', 'fixture-webhook-only');
  const { POST: webhook } = await import('@/app/api/github/webhook/route');
  const raw = JSON.stringify({
    action: 'opened', repository: { id: f.first.repositoryId, full_name: `fixture/repo-${sequence}` },
    pull_request: { id: f.first.pullRequestId, number: 7, title: 'Fixture PR', state: 'open',
      html_url: `https://github.com/fixture/repo-${sequence}/pull/7`,
      created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' },
  });
  getSqlite().prepare('UPDATE github_pull_requests SET repository_id = NULL WHERE pull_request_id = ?').run(f.first.pullRequestId);
  const signature = `sha256=${createHmac('sha256', 'fixture-webhook-only').update(raw).digest('hex')}`;
  const response = await webhook(new NextRequest('http://localhost/api/github/webhook', {
    method: 'POST', headers: { 'x-github-event': 'pull_request', 'x-hub-signature-256': signature }, body: raw,
  }));
  expect(response.status).toBe(200);
  expect(getSqlite().prepare('SELECT repository_id FROM github_pull_requests WHERE pull_request_id = ?')
    .get(f.first.pullRequestId)).toEqual({ repository_id: f.first.repositoryId });
  expect((await linksApi.POST(request('POST', { threadId: f.threadId, ...f.first }))).status).toBe(201);
});
