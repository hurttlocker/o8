import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, describe, expect, it, vi } from 'vitest';

vi.mock('@clerk/nextjs/server', () => ({ clerkMiddleware: (handler: unknown) => handler }));
vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: vi.fn(), requestRealtimeRefresh: vi.fn(), publishCortexChange: vi.fn() }));

const dataDir = mkdtempSync(join(tmpdir(), 'o8-transcript-visuals-'));
const token = 'operator-visualization-test-token-0123456789';
writeFileSync(join(dataDir, 'ws-token'), token);
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;
const repo = join(dataDir, 'repo');
mkdirSync(repo);
execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
writeFileSync(join(dataDir, 'repos.json'), JSON.stringify({ version: 1, repos: [{ id: 'visual-project', name: 'Project', localPath: repo,
  remoteUrl: null, defaultBranch: 'main', isGitRepo: true, addedAt: new Date().toISOString(), lastOpenedAt: new Date().toISOString() }] }));

const route = await import('@/app/api/visualizations/route');
const one = await import('@/app/api/visualizations/[id]/route');
const { panelGateMiddleware } = await import('@/middleware');
const { closeDb } = await import('@/lib/db');
const { mintPacketWorkerToken } = await import('@/lib/auth/packet-worker-token');
const { createLane, setLaneStatus } = await import('@/lib/lane/registry');
const { writePersistedLlmChat } = await import('@/lib/llm/chat-history-store');
const { prepareVisualizationHtml } = await import('@/lib/visualizations/prepare');
const { resolveVisualizationTarget } = await import('@/lib/visualizations/service');
const { visualizationBody } = await import('@/lib/visualizations/http');
const BASE = 'http://localhost:3001/api/visualizations';
const params = (id: string) => ({ params: Promise.resolve({ id }) });
function request(url: string, body?: unknown, bearer: string | null = token) {
  return new NextRequest(url, { method: body === undefined ? 'GET' : 'POST', headers: {
    ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), 'content-type': 'application/json',
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
afterAll(() => { closeDb(); rmSync(dataDir, { force: true, recursive: true }); });

describe('transcript visualizations through authenticated routes and persisted SQLite', () => {
  it('publishes, lists metadata, and reloads the exact document after a database restart', async () => {
    const body = { repoPath: repo, threadId: 'thoughts-visual-persist', title: 'Explore the plan', height: 320,
      html: '<button onclick="this.textContent=\'Changed\'">Explore</button><svg viewBox="0 0 400 120"><path d="M0 60H400"/></svg>' };
    const req = request(BASE, body);
    expect(panelGateMiddleware(req).status).toBe(200);
    const created = await route.POST(req);
    expect(created.status).toBe(201);
    const ref = (await created.json()).result.visualization;
    expect(ref).toMatchObject({ kind: 'o8-visualization', title: body.title, height: 320 });
    expect(ref.html).toBeUndefined();
    closeDb();
    const read = await one.GET(request(`${BASE}/${ref.id}`), params(ref.id));
    expect((await read.json()).result.visualization).toMatchObject({ ...body, id: ref.id, packetId: null });
    const listed = await route.GET(request(`${BASE}?${new URLSearchParams({ repoPath: repo, threadId: body.threadId })}`));
    expect((await listed.json()).result.visualizations).toEqual([ref]);
    const elsewhere = await route.GET(request(`${BASE}?${new URLSearchParams({ repoPath: repo, threadId: 'thoughts-other' })}`));
    expect((await elsewhere.json()).result.visualizations).toEqual([]);
    expect((await one.GET(request(`${BASE}/${ref.id}`, undefined, null), params(ref.id))).status).toBe(401);
  });

  it('binds workers to their own packet and hides other documents, including after the packet finishes', async () => {
    const packet = `pkt-${crypto.randomUUID()}`;
    const lane = createLane({ repoPath: repo, branch: 'main', runtime: 'codex', packetId: packet, sessionKey: 'fixture', worktreePath: repo, label: 'Visualization fixture' });
    const worker = mintPacketWorkerToken(packet);
    const req = request(BASE, { title: 'Worker diagram', html: '<p>Done</p>' }, worker);
    expect(panelGateMiddleware(req).status).toBe(200);
    const created = await route.POST(req);
    expect(created.status).toBe(201);
    const ref = (await created.json()).result.visualization;
    setLaneStatus(lane.id, 'completed');
    expect((await one.GET(request(`${BASE}/${ref.id}`, undefined, worker), params(ref.id))).status).toBe(200);
    expect((await one.GET(request(`${BASE}/${ref.id}`, undefined, mintPacketWorkerToken('pkt-other')), params(ref.id))).status).toBe(404);
    for (const target of [{ packetId: 'pkt-other' }, { threadId: 'thoughts-other' }, { repoPath: repo }]) {
      expect((await route.POST(request(BASE, { title: 'Wrong target', html: '<p>x</p>', ...target }, worker))).status).toBe(403);
    }
    const list = await route.GET(request(`${BASE}?packetId=${packet}`, undefined, worker));
    expect((await list.json()).result.visualizations).toEqual([ref]);
    expect((await route.GET(request(`${BASE}?packetId=pkt-other`, undefined, worker))).status).toBe(403);
    await expect(resolveVisualizationTarget({}, { role: 'worker', readOnly: true, packetId: null, tokenId: 'read',
      leaseProcessMarker: null, leaseProcessPid: null, leaseProcessGroupId: null })).rejects.toMatchObject({ status: 403 });
  });

  it('refuses an unregistered workspace, a mismatched thread, invalid dimensions, and oversized streamed JSON', async () => {
    const body = { title: 'Example', html: '<p>Example</p>', repoPath: repo, threadId: 'thoughts-invalid' };
    expect((await route.POST(request(BASE, { ...body, repoPath: dataDir }))).status).toBe(400);
    writePersistedLlmChat('thoughts-cross-workspace', { messages: [], repoPath: '/another/workspace' });
    expect((await route.POST(request(BASE, { ...body, threadId: 'thoughts-cross-workspace' }))).status).toBe(403);
    expect((await route.POST(request(BASE, { ...body, height: 1801 }))).status).toBe(400);
    expect((await route.POST(request(BASE, { ...body, html: 'x'.repeat(512 * 1024 + 1) }))).status).toBe(413);
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(601 * 1024)); controller.close(); } });
    await expect(visualizationBody(new Request(BASE, { method: 'POST', body: stream, duplex: 'half' } as RequestInit))).rejects.toMatchObject({ status: 413 });
  });

  it('inlines only descriptor-confined images with real image bytes', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
    writeFileSync(join(repo, 'plot.png'), png);
    const prepared = await prepareVisualizationHtml('<img src="plot.png"><img src="https://example.com/image.png">', repo);
    expect(prepared.html).toContain(`data:image/png;base64,${png.toString('base64')}`);
    expect(prepared.warnings).toHaveLength(1);
    await expect(prepareVisualizationHtml('<script type="module">export const x=1</script>', repo)).rejects.toMatchObject({ code: 'unsupported_script' });
    writeFileSync(join(repo, 'fake.png'), 'private text');
    await expect(prepareVisualizationHtml('<img src="fake.png">', repo)).rejects.toMatchObject({ code: 'invalid_image' });
    writeFileSync(join(dataDir, 'secret.png'), png);
    symlinkSync(join(dataDir, 'secret.png'), join(repo, 'escape.png'));
    await expect(prepareVisualizationHtml('<img src="escape.png">', repo)).rejects.toMatchObject({ status: 403 });
    await expect(prepareVisualizationHtml('<img src="../secret.png">', repo)).rejects.toMatchObject({ status: 403 });
  });

  it('counts repeated image expansion before allocating the final document', async () => {
    const image = Buffer.alloc(2 * 1024 * 1024);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(image);
    writeFileSync(join(repo, 'large.png'), image);
    await expect(prepareVisualizationHtml('<img src="large.png">'.repeat(10), repo)).rejects.toMatchObject({ code: 'document_too_large', status: 413 });
    const small = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
    writeFileSync(join(repo, 'small.png'), small);
    expect((await prepareVisualizationHtml('<img src="small.png">'.repeat(2), repo)).html.match(/data:image\/png/g)).toHaveLength(2);
  });
});
