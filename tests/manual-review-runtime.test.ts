import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({ provider: vi.fn(async () => { throw new Error('Unexpected review provider'); }) }));
vi.mock('@/lib/lane/review-quota-fallback', () => ({ runReviewerTurnWithQuotaFallback: calls.provider }));
vi.mock('@/lib/panel/auth', () => ({ requirePanelAuth: () => null }));
const data = mkdtempSync(join(tmpdir(), 'o8-manual-review-'));
vi.stubEnv('O8_DATA_DIR', data);
vi.stubEnv('CORTEX_IDE_DATA_DIR', data);
vi.stubEnv('O8_REVIEW_MODE', 'manual');
const { getSqlite, closeDb } = await import('@/lib/db');
const { createLane } = await import('@/lib/lane/registry');
const { drainReviewQueue } = await import('@/lib/lane/auto-review');
const { POST } = await import('@/app/api/review/auto-review/route');
const { routeReviewContinuation, queueReviewContinuation } = await import('@/lib/orchestrator/review-continuation');
const runtime = globalThis as typeof globalThis & { __o8ReviewQueueDrain?: {stop:()=>void} };
afterAll(() => {
  runtime.__o8ReviewQueueDrain?.stop(); delete runtime.__o8ReviewQueueDrain;
  closeDb(); vi.unstubAllEnvs(); rmSync(data, { recursive: true, force: true });
});

it('manual startup and explicit drain preserve a stale persisted claim and never launch review continuations', async () => {
  const lane = createLane({ repoPath: data, branch: 'fixture', runtime: 'codex', packetId: 'manual-packet' });
  const db = getSqlite();
  db.prepare("UPDATE lanes SET status='reviewing' WHERE id=?").run(lane.id);
  db.prepare(`INSERT INTO review_queue
    (id,lane_id,repo_path,status,attempts,head_sha,claimed_at,claim_owner,created_at,updated_at)
    VALUES (?,?,?,'in_progress',0,?,'2000-01-01 00:00:00','pid:999999:fixture','2000-01-01 00:00:00','2000-01-01 00:00:00')`)
    .run('manual-claim', lane.id, data, 'a'.repeat(40));
  const before = db.prepare('SELECT * FROM review_queue WHERE id=?').get('manual-claim');
  const result = await POST(new NextRequest('http://localhost/api/review/auto-review', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({action:'start'}),
  }));
  expect(result.status).toBe(200);
  expect(db.prepare('SELECT * FROM review_queue WHERE id=?').get('manual-claim')).toEqual(before);
  await drainReviewQueue();
  expect(db.prepare('SELECT * FROM review_queue WHERE id=?').get('manual-claim')).toEqual(before);
  const enqueue = vi.fn(); const persistent = vi.fn(() => true); const origin = vi.fn();
  routeReviewContinuation(lane, enqueue, persistent, origin);
  queueReviewContinuation(lane, enqueue);
  expect(enqueue).not.toHaveBeenCalled(); expect(persistent).not.toHaveBeenCalled(); expect(origin).not.toHaveBeenCalled();
  expect(calls.provider).not.toHaveBeenCalled();
});
