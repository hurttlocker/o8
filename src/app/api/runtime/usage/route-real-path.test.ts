import { NextRequest } from 'next/server';
import { afterEach, expect, it, vi } from 'vitest';
import { GET } from './route';

afterEach(() => vi.restoreAllMocks());
it('rejects unauthenticated remote reads and invalid ranges before accessing local history', async () => {
  const remote = await GET(new NextRequest('http://remote.invalid/api/runtime/usage'));
  expect(remote.status).toBe(401);
  const range = await GET(new NextRequest('http://localhost/api/runtime/usage?days=999', { headers: { host: 'localhost' } }));
  expect(range.status).toBe(400);
  const zone = await GET(new NextRequest('http://localhost/api/runtime/usage?timeZone=not-a-zone', { headers: { host: 'localhost' } }));
  expect(zone.status).toBe(400);
});

it('returns a prompt scanning response, then real aggregate data from an external CLI fixture', async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const root = await mkdtemp(join(tmpdir(), 'o8-history-route-'));
  const envs = ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'GROK_HOME', 'OPENCODE_DATA_DIR', 'ANTIGRAVITY_DATA_DIR'];
  const previous = envs.map(name => process.env[name]);
  envs.forEach(name => { process.env[name] = root; });
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ 'fixture-model': { input_cost_per_token: 0.000002, output_cost_per_token: 0.000008 } })));
  try {
    await mkdir(join(root, 'projects'));
    await writeFile(join(root, 'projects', 'external.jsonl'), JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), sessionId: 'external-session', requestId: 'external-request',
      message: { id: 'external-message', model: 'fixture-model', content: 'PRIVATE-CONTENT-MUST-NOT-LEAVE', usage: { input_tokens: 10, output_tokens: 20 } } }) + '\n');
    const request = () => new NextRequest('http://localhost/api/runtime/usage?days=7&timeZone=UTC', { headers: { host: 'localhost' } });
    const first = await GET(request()); expect(first.status).toBe(202);
    expect(await first.json()).toMatchObject({ status: 'scanning' });
    await vi.waitFor(async () => {
      const response = await GET(request()); expect(response.status).toBe(200);
      const data = await response.json(); expect(data.providerSessions).toEqual({ claude: 1 });
      expect(data.buckets[0]).toMatchObject({ totals: { uncachedInputTokens: 10, outputTokens: 20 }, unpricedRecords: 0 });
      expect(JSON.stringify(data)).not.toContain('PRIVATE-CONTENT-MUST-NOT-LEAVE'); expect(JSON.stringify(data)).not.toContain(root);
    }, { timeout: 5_000, interval: 100 });
    vi.resetModules();
    const reloaded = await import('./route');
    const retained = await reloaded.GET(request());
    expect(retained.status).toBe(200);
    expect((await retained.json()).providerSessions).toEqual({ claude: 1 });
  } finally {
    envs.forEach((name, index) => { if (previous[index] === undefined) delete process.env[name]; else process.env[name] = previous[index]; });
    vi.unstubAllGlobals(); await rm(root, { recursive: true, force: true });
  }
});
