import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const directory = mkdtempSync(join(tmpdir(), 'o8-published-notes-route-'));
vi.stubEnv('CORTEX_IDE_DATA_DIR', directory);
vi.mock('server-only', () => ({}));
const request = (version: string) => new NextRequest(`http://localhost/api/panel/o8-update-summary?version=${encodeURIComponent(version)}`);
const memory = globalThis as typeof globalThis & { __o8ReleaseNotesV1?: { cache: Map<string, unknown>; pending: Map<string, unknown> } };
const route = await import('./route');
beforeEach(() => { memory.__o8ReleaseNotesV1?.cache.clear(); vi.stubGlobal('fetch', vi.fn()); });
afterAll(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); rmSync(directory, { recursive: true, force: true }); });

describe('published release notes through the real route and persisted cache', () => {
  it('reads the publisher overview and bullets without inference and persists the shared result', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ tag_name: 'v0.1.904', body: '## What’s changed\n\nNavigate your work more clearly.\n\n- Clearer chat sections\n- One place for connected updates\n' }));
    const notes = await (await route.GET(request('0.1.904'))).json();
    expect(notes).toMatchObject({ source: 'release', overview: 'Navigate your work more clearly.', summary: 'Navigate your work more clearly.',
      entries: [{ text: 'Clearer chat sections' }, { text: 'One place for connected updates' }] });
    expect(fetch).toHaveBeenCalledOnce();
    expect(String(vi.mocked(fetch).mock.calls[0]![0])).toBe('https://api.github.com/repos/hurttlocker/o8-releases/releases/tags/v0.1.904');
    memory.__o8ReleaseNotesV1?.cache.clear(); vi.mocked(fetch).mockClear();
    expect(await (await route.GET(request('0.1.904'))).json()).toEqual(notes); expect(fetch).not.toHaveBeenCalled();
  });
  it('fetches once for concurrent hovers and reuses the disk receipt after memory is cleared', async () => {
    vi.mocked(fetch).mockResolvedValue(Response.json({ tag_name: 'v0.1.901', published_at: '2026-10-08T12:00:00Z', body: '- Faster sidebar\n- Clear update status' }));
    const [first, second] = await Promise.all([route.GET(request('0.1.901')), route.GET(request('0.1.901'))]);
    expect(first.status).toBe(200); expect(second.status).toBe(200); expect(fetch).toHaveBeenCalledTimes(1);
    const value = await first.json();
    expect(value).toMatchObject({ version: '0.1.901', source: 'release', entries: [{ text: 'Faster sidebar' }, { text: 'Clear update status' }] });
    expect(JSON.parse(readFileSync(join(directory, 'release-notes-cache/0.1.901.json'), 'utf8')).notes).toEqual(value);
    memory.__o8ReleaseNotesV1?.cache.clear(); vi.mocked(fetch).mockClear();
    expect(await (await route.GET(request('0.1.901'))).json()).toEqual(value); expect(fetch).not.toHaveBeenCalled();
  });
  it('labels the dated changelog fallback and excludes changes newer than the release', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ tag_name: 'v0.1.902', published_at: '2026-10-07T12:00:00Z', body: 'See release files.' }))
      .mockResolvedValueOnce(new Response('## 2026-10-08\n- Future change\n## 2026-10-07\n- Published change'));
    expect(await (await route.GET(request('0.1.902'))).json()).toMatchObject({ source: 'changelog', entries: [{ text: 'Published change', date: '2026-10-07' }] });
  });
  it('rejects unsafe versions without fetching and does not accept mismatched published tags', async () => {
    expect((await route.GET(request('../../commands'))).status).toBe(400); expect(fetch).not.toHaveBeenCalled();
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ tag_name: 'v0.1.1', body: '- Other release' }));
    expect((await route.GET(request('0.1.903'))).status).toBe(503);
  });
  it('does not trust a disk cache with an unrelated outbound URL', async () => {
    const file = join(directory, 'release-notes-cache/0.1.901.json');
    mkdirSync(join(directory, 'release-notes-cache'), { recursive: true });
    writeFileSync(file, JSON.stringify({ at: Date.now(), notes: { version: '0.1.901', summary: 'Cached', entries: [], source: 'release', releaseUrl: 'https://example.test' } }));
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ tag_name: 'v0.1.901', body: '- Verified public release' }));
    expect((await route.GET(request('0.1.901'))).status).toBe(200); expect(fetch).toHaveBeenCalledTimes(1);
  });
});
