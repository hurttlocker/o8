import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NextRequest } from 'next/server';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComposerQueuePayload } from '@/lib/orchestrator/composer-queue-types';

vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: vi.fn(async () => {}) }));
const fixture = realpathSync(mkdtempSync(join(tmpdir(), 'o8-composer-queue-')));
const repo = join(fixture, 'repo'); mkdirSync(repo);
vi.stubEnv('O8_DATA_DIR', fixture); vi.stubEnv('CORTEX_IDE_DATA_DIR', fixture);
vi.stubEnv('CORTEX_IDE_DB_PATH', join(fixture, 'queue.db'));
mkdirSync(join(fixture, 'chat-history'), { recursive: true });
for (const thread of ['thoughts-first', 'thoughts-second']) writeFileSync(join(fixture, 'chat-history', `${thread}.json`), JSON.stringify({ repoPath: repo, backend: 'codex', messages: [{ id: 'assistant', role: 'assistant', content: 'Working', timestamp: 1 }] }));
const { getSqlite, closeDb } = await import('@/lib/db');
const { ensureV71ComposerQueueSchema } = await import('@/lib/db/v71-composer-queue-migration');
ensureV71ComposerQueueSchema(getSqlite());
const queue = await import('@/lib/orchestrator/composer-queue');
const { GET, POST, DELETE } = await import('@/app/api/orchestrator/composer-queue/route');
const target = { repoPath: repo, threadId: 'thoughts-first' };
const payload: ComposerQueuePayload = { text: 'First message', wireMessage: 'Original mode directive\n\nFirst message',
  images: [{ name: 'proof.png', dataUri: 'data:image/png;base64,YQ==' }], routing: {
    backend: 'codex', model: 'model-at-enqueue', effort: 'low', serviceTier: 'priority', permissionMode: 'plan', mode: 'single', pickedMode: 'solo', collide: false, projectId: 'project-at-enqueue',
  } };
function request(method: string, body?: unknown, host = 'localhost') {
  return new NextRequest(`http://${host}/api/orchestrator/composer-queue`, { method, headers: { host, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
}
async function enqueue(id: string, update: Partial<ComposerQueuePayload> = {}) {
  const response = await POST(request('POST', { ...target, id, intent: 'send-next', payload: { ...payload, ...update } }));
  expect(response.status, JSON.stringify(await response.clone().json())).toBe(200);
  return (await response.json()).item;
}
beforeEach(() => getSqlite().exec('DELETE FROM composer_send_queue'));
afterAll(() => { closeDb(); vi.unstubAllEnvs(); rmSync(fixture, { recursive: true, force: true }); });

describe('durable composer queue API and persisted state', () => {
  it('preserves FIFO, exact destination, images and routing after reopening the database', async () => {
    const first = await enqueue('queue-first');
    const second = await enqueue('queue-second', { text: 'Second message' });
    await POST(request('POST', { ...target, threadId: 'thoughts-second', id: 'queue-other', intent: 'send-next', payload }));
    closeDb(); ensureV71ComposerQueueSchema(getSqlite());
    const response = await GET(new NextRequest(`http://localhost/api/orchestrator/composer-queue?repoPath=${encodeURIComponent(repo)}&threadId=thoughts-first`, { headers: { host: 'localhost' } }));
    expect(response.status).toBe(200);
    const items = (await response.json()).items;
    expect(items.map((item: { id: string }) => item.id)).toEqual([first.id, second.id]);
    expect(items[0]).toMatchObject({ ...target, payload, status: 'queued', admittedAt: null });
    expect(queue.listComposerQueueTargets()).toEqual([target, { ...target, threadId: 'thoughts-second' }]);
    expect(queue.claimNextComposerSend(target)?.id).toBe(first.id);
    expect(queue.claimNextComposerSend(target)).toBeNull();
    expect(queue.settleComposerSend(first.id, { status: 'applied' })).toBe(false);
    expect(queue.admitComposerSend(first.id)).toBe(true);
    expect(queue.settleComposerSend(first.id, { status: 'applied' })).toBe(true);
    expect(queue.claimNextComposerSend(target)?.id).toBe(second.id);
  });

  it('rejects mismatched targets and unsupported steer without inserting a FIFO blocker', async () => {
    const denied = await POST(request('POST', { ...target, id: 'queue-forbidden', intent: 'send-next', payload }, 'remote.invalid'));
    expect(denied.status).toBe(401);
    const otherRepo = join(fixture, 'other-repo'); mkdirSync(otherRepo, { recursive: true });
    expect((await POST(request('POST', { ...target, repoPath: otherRepo, id: 'queue-wrong-repo', intent: 'send-next', payload }))).status).toBe(400);
    const steer = await POST(request('POST', { ...target, id: 'queue-steer', intent: 'steer-now', payload }));
    expect(steer.status).toBe(409);
    expect((await steer.json()).error).toContain('Live steering is unavailable');
    expect(queue.listQueuedComposerSends(target)).toEqual([]);
    const legitimate = await enqueue('queue-legitimate');
    expect(queue.claimNextComposerSend(target)?.id).toBe(legitimate.id);
  });

  it('deduplicates exact retries and refuses changing an accepted payload or its attachments', async () => {
    const first = await enqueue('queue-idempotent');
    expect((await enqueue('queue-idempotent')).sequence).toBe(first.sequence);
    expect(queue.listQueuedComposerSends(target)).toHaveLength(1);
    expect((await POST(request('POST', { ...target, id: first.id, intent: 'send-next', payload: { ...payload, text: 'Changed' } }))).status).toBe(400);
    expect((await POST(request('POST', { ...target, id: 'queue-bad-image', intent: 'send-next', payload: { ...payload, images: [{ name: 'bad', dataUri: 'invalid' }] } }))).status).toBe(400);
    expect((await POST(request('POST', { ...target, id: 'queue-bad-tier', intent: 'send-next', payload: { ...payload, routing: { ...payload.routing, serviceTier: 'unrecognized-tier' } } }))).status).toBe(400);
    expect(queue.readComposerSend(first.id)?.payload).toEqual(payload);
    expect(queue.listQueuedComposerSends(target)).toHaveLength(1);
  });

  it('cancels queued and prepared items, fences provider admission, and refuses a false cancellation after admission', async () => {
    const first = await enqueue('queue-cancel');
    await enqueue('queue-preparing');
    expect((await DELETE(request('DELETE', { ...target, id: first.id }))).status).toBe(200);
    expect(queue.claimNextComposerSend(target)?.id).toBe('queue-preparing');
    expect((await DELETE(request('DELETE', { ...target, id: 'queue-preparing' }))).status).toBe(200);
    expect(() => queue.assertComposerSendClaim('queue-preparing')).toThrow('cancelled or held');
    expect(queue.admitComposerSend('queue-preparing')).toBe(false);
    const admitted = await enqueue('queue-admitted'); queue.claimNextComposerSend(target);
    expect(queue.admitComposerSend(admitted.id)).toBe(true);
    expect((await DELETE(request('DELETE', { ...target, id: admitted.id }))).status).toBe(409);
    expect(queue.readComposerSend(admitted.id)?.status).toBe('dispatching');
  });

  it('holds interrupted execution on recovery and prevents a stopped claim from starting a provider turn', async () => {
    await enqueue('queue-interrupted'); await enqueue('queue-behind');
    queue.claimNextComposerSend(target); queue.admitComposerSend('queue-interrupted');
    queue.recoverComposerSends();
    expect(queue.readComposerSend('queue-interrupted')).toMatchObject({ status: 'held', reason: expect.stringContaining('interrupted') });
    expect(queue.claimNextComposerSend(target)).toBeNull();
    await DELETE(request('DELETE', { ...target, id: 'queue-interrupted' }));
    expect(queue.claimNextComposerSend(target)?.id).toBe('queue-behind');
    queue.holdComposerSends(target);
    expect(() => queue.assertComposerSendClaim('queue-behind')).toThrow();
    expect(queue.admitComposerSend('queue-behind')).toBe(false);
    expect(queue.settleComposerSend('queue-behind', { status: 'applied' })).toBe(false);
  });
});
