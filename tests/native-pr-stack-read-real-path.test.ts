import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ fetch: vi.fn(), scope: 'synthetic-scope-a', installation: 5, available: true }));
vi.mock('@/lib/github-broker/env', () => ({ getGitHubAppConfig: () => null, requireGitHubAppConfig: () => { throw new Error('No app credential in this fixture'); } }));
vi.mock('@/lib/github-broker/managed', () => ({ readManagedGithubToken: () => fixture.available ? ({ token: fixture.scope, installationId: fixture.installation }) : null }));
const root = mkdtempSync(join(tmpdir(), 'o8-native-stack-read-'));
process.env.O8_DATA_DIR = root;
process.env.CORTEX_IDE_DATA_DIR = root;
const { GET } = await import('@/app/api/panel/pr/route');
const { closeDb, getSqlite } = await import('@/lib/db');
const { githubCredentialScope } = await import('@/lib/github-broker/request-budget');
const sha = (letter: string) => letter.repeat(40);
const repo = { id: 101, url: 'https://api.github.com/repos/example/widgets', name: 'widgets' };
const stack = () => ({
  id: 700, number: 7, node_id: 'S_fixture', base: { ref: 'main' },
  url: 'https://api.github.com/repos/example/widgets/stacks/7', open: true,
  pull_requests: [11, 12, 13].map((number, index) => ({
    number, title: `Layer ${index + 1}`, state: 'open',
    html_url: `https://github.com/example/widgets/pull/${number}`,
    head: { ref: `layer-${index + 1}`, sha: sha(String(index + 1)), repo },
    base: { ref: index ? `layer-${index}` : 'main', sha: sha(String(index)), repo },
  })),
});
let native = stack();
let list: unknown = [{ number: 7 }];
let failure: number | 'offline' | null = null;
let afterList: (() => void) | null = null;
const requests: Array<{ path: string; method: string }> = [];
let testSequence = 0;
function read() {
  return GET(new NextRequest('http://localhost/api/panel/pr?repo=example/widgets&number=11'));
}
async function context() { const response = await read(); expect(response.status).toBe(200); return (await response.json()).stack; }

beforeEach(() => {
  closeDb();
  fixture.scope = `synthetic-scope-a-${++testSequence}`; fixture.installation = testSequence;
  fixture.available = true; afterList = null;
  native = stack(); list = [{ number: 7 }]; failure = null; requests.length = 0;
  vi.stubGlobal('fetch', fixture.fetch);
  fixture.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
    const parsed = new URL(url); const path = parsed.pathname + parsed.search;
    requests.push({ path, method: init?.method ?? 'GET' });
    let response: Response;
    if (path.includes('/stacks')) {
      if (failure === 'offline') throw new TypeError('Synthetic network failure');
      response = failure ? Response.json({ message: 'Synthetic refusal' }, { status: failure })
        : Response.json(path.includes('?') ? list : native);
      if (path.includes('?')) afterList?.();
    } else if (path.endsWith('/pulls/11')) response = Response.json({ number: 11, title: 'Layer 1',
      state: 'open', html_url: 'https://github.com/example/widgets/pull/11',
      head: { sha: sha('1'), ref: 'layer-1' }, base: { sha: sha('0'), ref: 'main' } });
    else if (path.includes('/check-runs')) response = Response.json({ check_runs: [] });
    else response = Response.json([]);
    return response;
  });
});
afterAll(() => { closeDb(); vi.restoreAllMocks(); vi.unstubAllGlobals(); rmSync(root, { recursive: true, force: true }); });

describe('target PR native stack read through the real route and SQLite', () => {
  it('returns ordered native layers with exact revisions and persists them across reopen', async () => {
    const result = await context();
    expect(result).toMatchObject({ status: 'ready', stale: false, source: 'github-native',
      snapshot: { number: 7, id: 700, trunk: 'main', layers: [
        { number: 11, headSha: sha('1'), baseSha: sha('0') },
        { number: 12, headSha: sha('2'), baseSha: sha('1') },
        { number: 13, headSha: sha('3'), baseSha: sha('2') },
      ] } });
    expect(result.fetchedAt).toEqual(expect.any(String));
    closeDb();
    const row = getSqlite().prepare('SELECT observation_json FROM github_pr_stack_observations WHERE scope = ? AND repo = ? AND pr_number = ?')
      .get(githubCredentialScope('https://api.github.com', fixture.installation, fixture.scope), 'example/widgets', 11) as { observation_json: string };
    expect(JSON.parse(row.observation_json)).toEqual(result);
    expect(requests.filter(r => r.path.includes('/stacks')).map(r => r.path)).toEqual([
      '/repos/example/widgets/stacks?pull_request=11&per_page=2', '/repos/example/widgets/stacks/7',
    ]);
    expect(requests.every(r => r.method === 'GET')).toBe(true);
  });

  it('replaces changed provider revisions and clears membership on a confirmed empty list', async () => {
    const first = await context();
    native.pull_requests[2].head.sha = sha('4');
    expect((await context()).snapshot.layers[2].headSha).toBe(sha('4'));
    expect((await context()).revision).not.toBe(first.revision);
    list = [];
    expect(await context()).toMatchObject({ status: 'none', stale: false, snapshot: null });
    closeDb(); failure = 'offline';
    expect(await context()).toMatchObject({ status: 'offline', stale: true, snapshot: null });
  });

  it.each([401, 403, 404, 429, 503, 'offline'] as const)('keeps %s distinct from no stack and labels retained data stale', async (reason) => {
    await context(); closeDb(); failure = reason;
    const expected = reason === 'offline' ? 'offline' : reason === 401 || reason === 403 ? 'unauthorized'
      : reason === 404 ? 'unsupported_or_not_found' : reason === 429 ? 'deferred' : 'unavailable';
    expect(await context()).toMatchObject({ status: expected, stale: true, snapshot: reason === 401 || reason === 403 || reason === 429 || reason === 'offline' ? null : { number: 7 } });
  });

  it('never returns retained data from a different credential scope', async () => {
    await context(); closeDb(); fixture.scope = 'synthetic-scope-b'; failure = 'offline';
    expect(await context()).toMatchObject({ status: 'offline', stale: true, snapshot: null });
  });

  it.each(['response', 'offline', 'disconnected'] as const)('refuses retained context when authority changes between stack reads (%s)', async (mode) => {
    await context();
    afterList = () => {
      fixture.scope += '-changed';
      if (mode === 'offline') failure = 'offline';
      if (mode === 'disconnected') fixture.available = false;
    };
    expect(await context()).toMatchObject({ status: mode === 'offline' ? 'offline' : 'unauthorized', stale: true, snapshot: null });
  });

  it('prevents an older completed read from replacing a later observation', async () => {
    const originalFetch = fixture.fetch.getMockImplementation()!;
    let finish!: (response: Response) => void;
    let held = false;
    const oldNative = structuredClone(native);
    fixture.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/stacks/7') && !held) { held = true; return new Promise<Response>(resolve => { finish = resolve; }); }
      return originalFetch(url, init);
    });
    const old = context();
    await vi.waitFor(() => expect(held).toBe(true));
    native.pull_requests[2].head.sha = sha('8');
    const newer = await context();
    finish(Response.json(oldNative));
    expect(await old).toEqual(newer);
    closeDb(); failure = 503;
    expect((await context()).snapshot.layers[2].headSha).toBe(sha('8'));
  });

  it('does not disclose a newer retained snapshot when an older read loses authority', async () => {
    const originalFetch = fixture.fetch.getMockImplementation()!;
    let finish!: (response: Response) => void;
    let held = false;
    fixture.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes('/stacks?') && !held) { held = true; return new Promise<Response>(resolve => { finish = resolve; }); }
      return originalFetch(url, init);
    });
    const old = context();
    await vi.waitFor(() => expect(held).toBe(true));
    expect(await context()).toMatchObject({ status: 'ready', snapshot: { number: 7 } });
    fixture.scope += '-changed'; failure = 'offline';
    finish(Response.json([{ number: 7 }]));
    expect(await old).toMatchObject({ status: 'offline', stale: true, snapshot: null });
  });

  it('refuses cross-fork native data without substituting branch ancestry', async () => {
    native.pull_requests[1].head.repo = { ...repo, id: 999 };
    expect(await context()).toMatchObject({ status: 'unsupported_cross_fork', stale: true, snapshot: null });
  });

  it('refuses a partial or unrelated native stack response', async () => {
    native.pull_requests = native.pull_requests.slice(1);
    expect(await context()).toMatchObject({ status: 'unavailable', stale: true, snapshot: null });
  });

  it.each([null, [{ number: 7 }, { number: 8 }], [{ number: 0 }], 'x'.repeat(2 * 1024 * 1024)] )('refuses malformed, ambiguous and oversized native lists', async (value) => {
    list = value;
    expect(await context()).toMatchObject({ status: 'unavailable', stale: true, snapshot: null });
  });
});
