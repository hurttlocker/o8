import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ root: '', home: '', failSave: false, failCleanup: false, auth: vi.fn(), repo: vi.fn() }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, rmSync: (file: fs.PathLike, options?: fs.RmOptions) => {
    if (h.failCleanup && String(file).includes('.removed-')) throw new Error('Simulated cleanup failure');
    return actual.rmSync(file, options);
  }, renameSync: (from: fs.PathLike, to: fs.PathLike) => {
    if (h.failSave && String(to).endsWith('installed.json')) throw new Error('Simulated write failure');
    return actual.renameSync(from, to);
  } };
});
vi.mock('@/lib/panel/auth', () => ({ requirePanelAuth: h.auth }));
vi.mock('@/lib/data-dir-migration', () => ({ getDataDir: () => path.join(h.root, 'data') }));
vi.mock('@/lib/repos/registry', () => ({ findRepoByLocalPath: h.repo }));
vi.mock('node:os', () => ({ default: { homedir: () => h.home } }));
import { GET, POST } from './route';
import { GET as readSkill, POST as create } from '../skills/route';
import { GET as inventory } from '../inventory/route';
import { PROJECT_GUIDE } from '@/lib/customize/packages';
function request(body?: unknown, url = 'http://localhost/api/customize/plugins') {
  return new NextRequest(url, body ? { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : undefined);
}
async function mutate(body: unknown) { return POST(request(body)); }
async function entries(repo?: string) {
  const result = await inventory(request(undefined, `http://localhost/api/customize/inventory${repo ? `?repo=${encodeURIComponent(repo)}` : ''}`));
  return (await result.json()).skills as Array<{ name: string; file: string }>;
}
describe('persistent customization entry points', () => {
  beforeEach(() => {
    h.failSave = false; h.failCleanup = false;
    h.root = mkdtempSync('/tmp/o8-install-route-');
    h.home = path.join(h.root, 'home');
    mkdirSync(h.home);
    mkdirSync(path.join(h.root, 'data'));
    mkdirSync(path.join(h.root, 'repo'));
    h.auth.mockReset().mockReturnValue(null);
    h.repo.mockReset().mockImplementation(async (localPath) => localPath === path.join(h.root, 'repo') ? { localPath } : null);
  });
  afterEach(() => { vi.restoreAllMocks(); return rmSync(h.root, { force: true, recursive: true }); });
  it('installs through the route, reloads persisted files, updates, disables, enables and removes', async () => {
    const response = await mutate({ action: 'install', manifest: PROJECT_GUIDE, expectedRevision: null });
    expect(response.status).toBe(200);
    const installed = (await response.json()).installed;
    expect(readFileSync(installed.files[0].file, 'utf8')).toContain(PROJECT_GUIDE.skills[0].instructions);
    expect((await GET(request())).status).toBe(200);
    expect(await entries()).toHaveLength(2);
    expect((await mutate({ action: 'install', manifest: PROJECT_GUIDE, expectedRevision: null })).status).toBe(409);
    const next = { ...PROJECT_GUIDE, version: '1.1.0', skills: [PROJECT_GUIDE.skills[0]] };
    const updated = await mutate({ action: 'install', manifest: next, expectedRevision: installed.revision });
    expect(updated.status).toBe(200);
    const revision = (await updated.json()).installed.revision;
    expect(await entries()).toHaveLength(1);
    expect((await mutate({ action: 'disable', id: next.id, revision: installed.revision })).status).toBe(409);
    expect((await mutate({ action: 'disable', id: next.id, revision })).status).toBe(200);
    expect(await entries()).toHaveLength(0);
    expect((await mutate({ action: 'enable', id: next.id, revision })).status).toBe(200);
    expect(await entries()).toHaveLength(1);
    expect((await mutate({ action: 'remove', id: next.id, revision })).status).toBe(200);
    expect(await entries()).toHaveLength(0);
    expect((await (await GET(request())).json()).installed).toHaveLength(0);
  });
  it('creates and imports scoped skills without overwriting existing files', async () => {
    const repo = path.join(h.root, 'repo');
    const draft = { name: 'check-layout', description: 'Review layout', instructions: 'Check narrow and wide screens.' };
    expect((await create(request({ repo, skill: draft }))).status).toBe(201);
    const skills = await entries(repo);
    expect(skills).toHaveLength(1);
    expect(readFileSync(skills[0].file, 'utf8')).toContain(draft.instructions);
    expect((await create(request({ repo, skill: draft }))).status).toBe(409);
    expect(await entries()).toHaveLength(0);
    expect((await create(request({ markdown: '---\nname: personal-skill\ndescription: Personal test\n---\nRead instructions.' }))).status).toBe(201);
    expect(await entries()).toHaveLength(1);
    expect(await entries(repo)).toHaveLength(2);
  });
  it('rejects auth, unknown scopes, oversized bodies and executable or malformed manifests', async () => {
    h.auth.mockReturnValueOnce(Response.json({ error: 'Unauthorized' }, { status: 401 }));
    expect((await mutate({ action: 'install', manifest: PROJECT_GUIDE, expectedRevision: null })).status).toBe(401);
    expect((await mutate({ action: 'install', manifest: PROJECT_GUIDE, expectedRevision: null, repo: '/unregistered' })).status).toBe(403);
    expect((await mutate({ action: 'install', manifest: { ...PROJECT_GUIDE, hooks: ['run-me'] }, expectedRevision: null })).status).toBe(400);
    expect((await mutate({ action: 'install', manifest: { ...PROJECT_GUIDE, id: '../escape' }, expectedRevision: null })).status).toBe(400);
    expect((await mutate({ huge: 'x'.repeat(520 * 1024) })).status).toBe(413);
    expect((await create(request({ skill: { name: '../escape', description: 'x', instructions: 'x' } }))).status).toBe(400);
  });

  it('returns personal instructions through the authenticated API instead of teaching a sandbox-inaccessible path', async () => {
    const installed = (await (await mutate({ action: 'install', manifest: PROJECT_GUIDE, expectedRevision: null })).json()).installed;
    const response = await readSkill(request(undefined, `http://localhost/api/customize/skills?file=${encodeURIComponent(installed.files[0].file)}`));
    expect(response.status).toBe(200);
    expect((await response.json()).instructions).toContain(PROJECT_GUIDE.skills[0].instructions);
    expect((await readSkill(request(undefined, `http://localhost/api/customize/skills?file=${encodeURIComponent(path.join(h.home, '.ssh', 'id_rsa'))}`))).status).toBe(403);
    await mutate({ action: 'disable', id: PROJECT_GUIDE.id, revision: installed.revision });
    expect((await readSkill(request(undefined, `http://localhost/api/customize/skills?file=${encodeURIComponent(installed.files[0].file)}`))).status).toBe(403);
  });
  it('stores repository plugin files outside the worker-writable repository and detects altered contents', async () => {
    const repo = path.join(h.root, 'repo');
    const installed = (await (await mutate({ repo, action: 'install', manifest: PROJECT_GUIDE, expectedRevision: null })).json()).installed;
    expect(installed.files[0].file.startsWith(repo + path.sep)).toBe(false);
    fs.writeFileSync(installed.files[0].file, 'Changed after review');
    const result = await GET(request(undefined, `http://localhost/api/customize/plugins?repo=${encodeURIComponent(repo)}`));
    expect(result.status).toBe(200);
    expect((await result.json()).damaged).toEqual([expect.objectContaining({ id: PROJECT_GUIDE.id })]);
    expect((await mutate({ repo, action: 'remove', id: PROJECT_GUIDE.id, revision: 'damaged' })).status).toBe(200);
    expect((await (await GET(request(undefined, `http://localhost/api/customize/plugins?repo=${encodeURIComponent(repo)}`))).json()).damaged).toEqual([]);
  });
  it('keeps the old version usable after a failed update and permits retry', async () => {
    const installed = (await (await mutate({ action: 'install', manifest: PROJECT_GUIDE, expectedRevision: null })).json()).installed;
    const next = { ...PROJECT_GUIDE, version: '1.1.0' };
    h.failSave = true;
    expect((await mutate({ action: 'install', manifest: next, expectedRevision: installed.revision })).status).toBe(500);
    h.failSave = false;
    expect((await (await GET(request())).json()).installed[0].manifest.version).toBe('1.0.0');
    expect((await mutate({ action: 'install', manifest: next, expectedRevision: installed.revision })).status).toBe(200);
  });
  it('reports a removed installation with pending cleanup instead of a failed removal', async () => {
    const installed = (await (await mutate({ action: 'install', manifest: PROJECT_GUIDE, expectedRevision: null })).json()).installed;
    expect((await mutate({ action: 'remove', id: PROJECT_GUIDE.id, revision: 'damaged' })).status).toBe(409);
    h.failCleanup = true;
    const response = await mutate({ action: 'remove', id: PROJECT_GUIDE.id, revision: installed.revision });
    h.failCleanup = false;
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ cleanupPending: true });
    expect((await (await GET(request())).json()).installed).toEqual([]);
  });
  it('denies instruction reads before inspecting local files', async () => {
    h.auth.mockReturnValueOnce(Response.json({ error: 'Unauthorized' }, { status: 401 }));
    const response = await readSkill(request(undefined, 'http://localhost/api/customize/skills?file=/private&repo=/unregistered'));
    expect(response.status).toBe(401);
    expect(h.repo).not.toHaveBeenCalled();
  });
  it('recovers an unpublished revision left by an interrupted update', async () => {
    const installed = (await (await mutate({ action: 'install', manifest: PROJECT_GUIDE, expectedRevision: null })).json()).installed;
    const next = { ...PROJECT_GUIDE, version: '1.1.0' };
    const revision = createHash('sha256').update(JSON.stringify(next)).digest('hex');
    mkdirSync(path.join(path.dirname(path.dirname(installed.files[0].file)), revision));
    expect((await mutate({ action: 'install', manifest: next, expectedRevision: installed.revision })).status).toBe(200);
    expect((await mutate({ action: 'install', manifest: PROJECT_GUIDE, expectedRevision: revision })).status).toBe(409);
  });
  it('rejects linked skill and plugin directories, preserving the external target', async () => {
    const repo = path.join(h.root, 'repo');
    const outside = path.join(h.root, 'outside');
    mkdirSync(outside);
    mkdirSync(path.join(repo, '.agents'));
    symlinkSync(outside, path.join(repo, '.agents', 'skills'));
    expect((await create(request({ repo, skill: PROJECT_GUIDE.skills[0] }))).status).toBe(400);
    mkdirSync(path.join(h.root, 'data', 'customizations'));
    symlinkSync(outside, path.join(h.root, 'data', 'customizations', 'projects'));
    expect((await mutate({ repo, action: 'install', manifest: PROJECT_GUIDE, expectedRevision: null })).status).toBe(400);
    expect(await entries()).toHaveLength(0);
  });
});
