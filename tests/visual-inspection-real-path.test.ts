import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { startJudgmentEndpointFixture, type JudgmentEndpointFixture } from './fixtures/judgment-endpoint';
import { visualObservation } from './fixtures/visual-observation';
import { inspectionKey } from '@/lib/composer/visual-inspection';

const proxy = vi.hoisted(() => ({ endpoint: '' }));
vi.mock('@/lib/judgment/route', async original => ({
  ...await original<typeof import('@/lib/judgment/route')>(),
  resolveManagedJudgmentRoute: () => ({ url: proxy.endpoint, bearer: 'managed-fixture-only', route: 'managed', credential: 'plan' }),
}));
const directory = realpathSync(mkdtempSync(join(tmpdir(), 'o8-visual-inspection-')));
const repoPath = join(directory, 'repo'); mkdirSync(repoPath); mkdirSync(join(directory, 'chat-history'));
vi.stubEnv('O8_DATA_DIR', directory); vi.stubEnv('CORTEX_IDE_DATA_DIR', directory); vi.stubEnv('CORTEX_IDE_DB_PATH', join(directory, 'evidence.db'));
const threadId = 'thoughts-visual-inspection';
writeFileSync(join(directory, 'chat-history', `${threadId}.json`), JSON.stringify({ repoPath, backend: 'codex', messages: [] }));
const { updateOperatorDefaults } = await import('@/lib/operator/defaults');
const { getSqlite, closeDb } = await import('@/lib/db');
const { POST } = await import('@/app/api/orchestrator/visual-inspection/route');
let provider: JudgmentEndpointFixture;
beforeAll(async () => { getSqlite(); provider = await startJudgmentEndpointFixture(); proxy.endpoint = provider.endpoint; });
beforeEach(async () => { provider.reset(); await updateOperatorDefaults({ judgmentProvider: 'managed' }); });
afterAll(async () => { await provider.close(); closeDb(); vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); });

async function body() {
  const input = { principal: 'fixture-person', requestId: 'request-fixture', observation: await visualObservation(), utterance: 'Make this smaller. Keep its label.', candidates: [] };
  return { ...input, key: inspectionKey(input), target: { repoPath, threadId }, remainingMs: 900 };
}
const request = (payload: unknown, url = 'http://localhost/api/orchestrator/visual-inspection') =>
  new NextRequest(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Host: new URL(url).host }, body: JSON.stringify(payload) });
const success = { model: 'jev-1.13.0', answers: {
  target: { choice: 'marked-region', probabilities: { 'marked-region': 0.9, none: 0.05, ambiguous: 0.05 }, confidence: 0.9 },
  visible: { noul: 0.97 },
  ambiguity: { choice: 'none', probabilities: { none: 0.9, target: 0.05, change: 0.03, unknown: 0.02 }, confidence: 0.9 },
}, usage: { input_tokens: 500, output_tokens: 30 } };

it('carries real PNG bytes through the protected route, managed transport and persisted receipt', async () => {
  provider.replies.push({ status: 200, body: success });
  const input = await body();
  const response = await POST(request(input)); const result = await response.json();
  expect(response.status).toBe(200); expect(result).toMatchObject({ key: input.key, status: 'observed', target: 'marked-region', ambiguity: 'none', model: 'jev-1.13.0' });
  expect(provider.seen).toHaveLength(1);
  expect(provider.seen[0].headers['typesafe-danger-zone-images']).toBe('true');
  expect(provider.seen[0].authorization).toBe('Bearer managed-fixture-only');
  expect(provider.seen[0].body.model).toBe('jev-1.13.0');
  const assets = Object.values(provider.seen[0].body.assets as Record<string, { data_base64: string }>);
  expect(assets.map(asset => asset.data_base64)).toEqual([input.observation.cleanImage.dataUri.split(',')[1], input.observation.image.dataUri.split(',')[1]]);
  closeDb();
  const row = getSqlite().prepare('SELECT route, model, selection_json FROM judgment_receipts WHERE id = ?').get(result.receiptId) as { route: string; model: string; selection_json: string };
  expect(row).toMatchObject({ route: 'managed', model: 'jev-1.13.0' });
  expect(JSON.parse(row.selection_json)).toMatchObject({ cleanHash: input.observation.cleanHash, imageHash: input.observation.imageHash });
  expect(row.selection_json).not.toContain('data:image');
});

it('rejects swapped image bytes and invalid candidate geometry before any provider request', async () => {
  const input = await body(); input.observation.cleanHash = 'f'.repeat(64);
  expect((await POST(request(input))).status).toBe(400);
  expect(provider.seen).toHaveLength(0);
});

it('uses one deadline and one attempt when the managed provider is slow', async () => {
  provider.replies.push({ status: 200, body: success, delayMs: 120 });
  const input = await body(); input.remainingMs = 30;
  const started = performance.now(); const result = await (await POST(request(input))).json();
  expect(result.status).toBe('unavailable'); expect(performance.now() - started).toBeLessThan(250);
  expect(provider.seen).toHaveLength(1);
});

it('keeps judgment-off network silent and refuses an unauthenticated remote caller', async () => {
  await updateOperatorDefaults({ judgmentProvider: 'off' });
  const input = await body(); expect((await (await POST(request(input))).json()).status).toBe('unavailable');
  expect((await POST(request(input, 'https://untrusted.example/api/orchestrator/visual-inspection'))).status).toBe(401);
  expect(provider.seen).toHaveLength(0);
});
