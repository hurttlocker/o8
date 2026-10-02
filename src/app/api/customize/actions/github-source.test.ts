import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ root: '', auth: vi.fn() }));
vi.mock('@/lib/panel/auth', () => ({ requirePanelAuth: state.auth }));
vi.mock('@/lib/data-dir-migration', () => ({ getDataDir: () => path.join(state.root, 'data'), migrateDataDirOnce: () => {} }));
vi.mock('@/lib/repos/registry', () => ({ findRepoByLocalPath: async () => null }));
import { GET, POST } from './route';

const commit = 'a'.repeat(40);
const rootTree = 'b'.repeat(40);
const packageTree = 'c'.repeat(40);
const origin = { kind: 'github', repository: 'test-owner/action-source', commit, directory: 'package' };
function hash(bytes: Buffer | string) { return createHash('sha256').update(bytes).digest('hex'); }
function blob(bytes: Buffer) { return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'); }
function request(body?: unknown) { return new NextRequest('http://localhost/api/customize/actions', body === undefined ? undefined : { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }); }
async function post(body: unknown) { return POST(request(body)); }
const reviewInput = { action: 'review-github', repository: origin.repository, commit, directory: origin.directory };

describe('immutable GitHub action sources through the operator route', () => {
  const fetchSource = vi.fn();
  let script: Buffer;
  let manifest: Buffer;
  let entries: Array<{ path: string; mode: string; type: string; sha: string; size: number }>;
  beforeEach(() => {
    state.root = realpathSync(mkdtempSync('/tmp/o8-github-action-'));
    mkdirSync(path.join(state.root, 'data'));
    state.auth.mockReset().mockReturnValue(null);
    script = Buffer.from('#!/bin/sh\nprintf "pinned source\\n"\n');
    manifest = Buffer.from(JSON.stringify({ format: 'o8-actions-v1', id: 'source-check', name: 'Source check', version: '1.0.0', description: 'Check an exact source', supportedPlatforms: [process.platform], workspace: 'none', files: [{ path: 'run.sh', sha256: hash(script) }], actions: [{ id: 'run', description: 'Run source check', entry: 'run.sh', args: [], timeoutMs: 5000 }] }));
    entries = [{ path: 'o8-actions.json', mode: '100644', type: 'blob', sha: blob(manifest), size: manifest.length }, { path: 'run.sh', mode: '100755', type: 'blob', sha: blob(script), size: script.length }];
    fetchSource.mockReset().mockImplementation(async (location: string) => {
      const url = String(location);
      if (url.endsWith(`/git/commits/${commit}`)) return Response.json({ sha: commit, tree: { sha: rootTree } });
      if (url.endsWith(`/git/trees/${rootTree}`)) return Response.json({ sha: rootTree, truncated: false, tree: [{ path: 'package', mode: '040000', type: 'tree', sha: packageTree }] });
      if (url.endsWith(`/git/trees/${packageTree}`)) return Response.json({ sha: packageTree, truncated: false, tree: entries });
      if (url.endsWith('/package/o8-actions.json')) return new Response(manifest);
      if (url.endsWith('/package/run.sh')) return new Response(script);
      throw new Error(`Unexpected source request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchSource);
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); rmSync(state.root, { recursive: true, force: true }); });

  it('acquires only pinned files, requires a separate link/run, persists origin, and re-reviews cached bytes after restart', async () => {
    const response = await post(reviewInput);
    expect(response.status, JSON.stringify(await response.clone().json())).toBe(200);
    const review = (await response.json()).review;
    expect(review.source).toEqual(origin);
    expect(review.files[0].content).toBe(script.toString());
    expect((await (await GET(request())).json()).installed).toEqual([]);
    expect((await post({ action: 'invoke', id: 'source-check', actionId: 'run', revision: review.revision })).status).toBe(404);
    expect(fetchSource).toHaveBeenCalledTimes(8);
    for (const [url, options] of fetchSource.mock.calls) {
      expect(String(url)).toMatch(/^https:\/\/(api\.github\.com|raw\.githubusercontent\.com)\//);
      expect(options).toMatchObject({ redirect: 'error', credentials: 'omit' });
      expect(new Headers(options.headers).has('authorization')).toBe(false);
      expect(new Headers(options.headers).has('cookie')).toBe(false);
    }
    expect(readdirSync(review.sourceDirectory).sort()).toEqual(['.origin.json', 'o8-actions.json', 'run.sh']);
    expect((await post({ action: 'link', directory: review.sourceDirectory, expectedRevision: review.revision })).status).toBe(200);
    const saved = JSON.parse(readFileSync(path.join(state.root, 'data/customizations/actions/source-check/installed.json'), 'utf8'));
    expect(saved.source).toEqual(origin);
    expect((await (await post({ action: 'invoke', id: 'source-check', actionId: 'run', revision: review.revision })).json()).receipt).toMatchObject({ status: 'succeeded', stdout: 'pinned source\n' });
    vi.resetModules();
    const restarted = await import('./route');
    expect((await (await restarted.GET(request())).json()).installed[0].source).toEqual(origin);
    const rereview = await restarted.POST(request(reviewInput));
    expect(rereview.status).toBe(200);
    expect((await rereview.json()).review.revision).toBe(review.revision);
    expect(fetchSource).toHaveBeenCalledTimes(14);
    expect(fetchSource.mock.calls.filter(([url]) => String(url).startsWith('https://raw.githubusercontent.com/'))).toHaveLength(2);
    expect((await post({ action: 'remove', id: 'source-check', revision: review.revision })).status).toBe(200);
    expect((await (await restarted.GET(request())).json()).receipts[0]).toMatchObject({ source: origin, revision: review.revision });
    expect((await (await restarted.GET(request())).json()).installed).toEqual([]);
  });

  it('authenticates before fetching and refuses refs, arbitrary URLs and traversal', async () => {
    state.auth.mockReturnValueOnce(Response.json({ error: 'Unauthorized' }, { status: 401 }));
    expect((await post(reviewInput)).status).toBe(401);
    for (const input of [{ ...reviewInput, commit: 'main' }, { ...reviewInput, repository: 'https://example.invalid/a/b' }, { ...reviewInput, directory: '../package' }, { ...reviewInput, directory: '/package' }, { ...reviewInput, directory: 'x/'.repeat(9) + 'y' }, { ...reviewInput, source: origin }]) expect((await post(input)).status).toBe(400);
    expect(fetchSource).not.toHaveBeenCalled();
  });

  it('rejects linked directories, symlink files and mismatched Git bytes before installation', async () => {
    fetchSource.mockResolvedValueOnce(Response.json({ sha: commit, tree: { sha: rootTree } }))
      .mockResolvedValueOnce(Response.json({ sha: rootTree, truncated: false, tree: [{ path: 'package', mode: '120000', type: 'blob', sha: packageTree }] }));
    expect((await post(reviewInput)).status).toBe(400);
    entries[1].mode = '120000';
    expect((await post(reviewInput)).status).toBe(400);
    entries[1].mode = '100755';
    entries[1].sha = 'd'.repeat(40);
    expect((await post(reviewInput)).status).toBe(409);
    expect((await (await GET(request())).json()).installed).toEqual([]);
    expect(readdirSync(path.join(state.root, 'data/customizations/action-sources'))).toEqual([]);
  });

  it('bounds streaming responses and leaves failed acquisitions without staging files', async () => {
    fetchSource.mockResolvedValueOnce(new Response('x'.repeat(2 * 1024 * 1024 + 1)));
    const response = await post(reviewInput);
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe('source_too_large');
    expect(readdirSync(path.join(state.root, 'data/customizations/action-sources'))).toEqual([]);
    fetchSource.mockResolvedValueOnce(new Response('', { status: 503 }));
    expect((await post(reviewInput)).status).toBe(502);
    expect((await (await GET(request())).json()).receipts).toEqual([]);
  });

  it('rejects changed cached bytes or metadata and preserves the installed snapshot', async () => {
    const review = (await (await post(reviewInput)).json()).review;
    expect((await post({ action: 'link', directory: review.sourceDirectory, expectedRevision: review.revision })).status).toBe(200);
    writeFileSync(path.join(review.sourceDirectory, 'run.sh'), '#!/bin/sh\nexit 1\n');
    expect((await post(reviewInput)).status).toBe(409);
    const originalFile = path.join(state.root, 'data/customizations/actions/source-check/run.sh');
    expect(readFileSync(originalFile)).toEqual(script);
    writeFileSync(path.join(review.sourceDirectory, 'run.sh'), script);
    writeFileSync(path.join(review.sourceDirectory, '.origin.json'), JSON.stringify({ source: { ...origin, commit: 'd'.repeat(40) }, manifestSha256: hash(manifest) }));
    expect((await post({ action: 'link', directory: review.sourceDirectory, expectedRevision: review.revision })).status).toBe(409);
    expect((await (await GET(request())).json()).installed[0].source).toEqual(origin);
    expect(fetchSource).toHaveBeenCalledTimes(11);
  });

  it('rechecks Git provenance when cached files, manifest and local metadata are coherently rewritten', async () => {
    const review = (await (await post(reviewInput)).json()).review;
    const changed = Buffer.from('#!/bin/sh\nprintf "changed cache\\n"\n');
    const changedManifest = Buffer.from(JSON.stringify({ ...JSON.parse(manifest.toString()), files: [{ path: 'run.sh', sha256: hash(changed) }] }));
    writeFileSync(path.join(review.sourceDirectory, 'run.sh'), changed);
    writeFileSync(path.join(review.sourceDirectory, 'o8-actions.json'), changedManifest);
    writeFileSync(path.join(review.sourceDirectory, '.origin.json'), JSON.stringify({ source: origin, manifestSha256: hash(changedManifest) }));
    expect((await post(reviewInput)).status).toBe(409);
    expect((await post({ action: 'review', directory: review.sourceDirectory })).status).toBe(409);
    expect((await post({ action: 'link', directory: review.sourceDirectory, expectedRevision: review.revision })).status).toBe(409);
    expect((await (await GET(request())).json()).installed).toEqual([]);
  });

  it('handles concurrent first acquisition with one complete cache and no leftover stages', async () => {
    const responses = await Promise.all([post(reviewInput), post(reviewInput)]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    const reviews = await Promise.all(responses.map(async (response) => (await response.json()).review));
    expect(reviews[0].revision).toBe(reviews[1].revision);
    expect(readdirSync(path.join(state.root, 'data/customizations/action-sources'))).toEqual([path.basename(reviews[0].sourceDirectory)]);
  });

  it('adds provenance storage without changing existing receipts', async () => {
    const directory = path.join(state.root, 'data/customizations/actions'); mkdirSync(directory, { recursive: true });
    const database = new Database(path.join(directory, 'receipts.sqlite'));
    database.exec('CREATE TABLE receipts (id TEXT PRIMARY KEY, plugin_id TEXT NOT NULL, action_id TEXT NOT NULL, actor TEXT NOT NULL, revision TEXT NOT NULL, status TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, exit_code INTEGER, stdout TEXT, stderr TEXT, error TEXT)');
    database.prepare('INSERT INTO receipts (id, plugin_id, action_id, actor, revision, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('legacy-receipt', 'legacy', 'run', 'local-operator', 'a'.repeat(64), 'succeeded', new Date(0).toISOString());
    database.close();
    expect((await (await GET(request())).json()).receipts[0]).toMatchObject({ id: 'legacy-receipt', source: null, status: 'succeeded' });
    const reopened = new Database(path.join(directory, 'receipts.sqlite'));
    expect(reopened.prepare('PRAGMA table_info(receipts)').all()).toContainEqual(expect.objectContaining({ name: 'source_metadata' })); reopened.close();
  });

  it('refuses linked source storage before acquiring any bytes', async () => {
    mkdirSync(path.join(state.root, 'data/customizations'));
    const outside = path.join(state.root, 'outside'); mkdirSync(outside);
    symlinkSync(outside, path.join(state.root, 'data/customizations/action-sources'));
    expect((await post(reviewInput)).status).toBe(400);
    expect(fetchSource).not.toHaveBeenCalled();
    expect(existsSync(path.join(outside, '.origin.json'))).toBe(false);
  });

  it('reviews, links and invokes through the actual built CLI and records the persisted source and receipt', async () => {
    execFileSync(process.execPath, [path.join(process.cwd(), 'cli/esbuild.config.mjs')], { cwd: process.cwd() });
    state.auth.mockImplementation((incoming: NextRequest) => incoming.headers.get('authorization') === 'Bearer github-source-test-token' ? null : Response.json({ error: 'Unauthorized' }, { status: 401 }));
    const server = createServer(async (incoming, outgoing) => {
      try {
        const chunks: Buffer[] = []; for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
        const req = new NextRequest(`http://localhost${incoming.url}`, { method: incoming.method, headers: { authorization: incoming.headers.authorization ?? '', 'content-type': 'application/json' }, ...(incoming.method === 'POST' ? { body: Buffer.concat(chunks) } : {}) });
        const response = incoming.method === 'POST' ? await POST(req) : await GET(req);
        outgoing.writeHead(response.status, { 'content-type': 'application/json' }); outgoing.end(await response.text());
      } catch { outgoing.writeHead(500); outgoing.end('{}'); }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture port');
    const cli = (args: string[]) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(process.cwd(), 'cli/dist/o8.mjs'), ...args], { cwd: state.root, env: { ...process.env, HOME: state.root, O8_DATA_DIR: path.join(state.root, 'data'), O8_API_PORT: String(address.port), O8_API_TOKEN: 'github-source-test-token', O8_WORKER_TOKEN: '', O8_SPECTATOR_TOKEN: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = ''; let stderr = ''; child.stdout.on('data', (chunk: Buffer) => { stdout += chunk; }); child.stderr.on('data', (chunk: Buffer) => { stderr += chunk; }); child.on('error', reject); child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
    try {
      const reviewed = await cli(['plugin', 'source', 'review', '--github', origin.repository, '--commit', commit, '--path', 'package']);
      expect(reviewed.code, reviewed.stderr).toBe(0);
      const { review } = JSON.parse(reviewed.stdout);
      expect(review.source).toEqual(origin);
      const linked = await cli(['plugin', 'source', 'link', '--directory', review.sourceDirectory, '--revision', review.revision]);
      expect(linked.code, linked.stderr).toBe(0);
      expect(JSON.parse(linked.stdout).installed.source).toEqual(origin);
      const ran = await cli(['plugin', 'action', 'invoke', 'source-check', 'run', '--revision', review.revision]);
      expect(ran.code, ran.stderr).toBe(0);
      expect(JSON.parse(ran.stdout).receipt).toMatchObject({ status: 'succeeded', stdout: 'pinned source\n' });
      const listed = await cli(['plugin', 'list']); expect(JSON.parse(listed.stdout).plugins[0].source).toEqual(origin);
      const logs = await cli(['plugin', 'log', 'list', '--plugin', 'source-check']); expect(JSON.parse(logs.stdout).receipts[0].revision).toBe(review.revision);
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  }, 30_000);
});
