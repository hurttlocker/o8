/**
 * #2511 — the catchUp replay label, through `runReplay`.
 *
 * Real-path doctrine: ranking receipts go through the real
 * `recordJudgmentReceipt` with no lane (so they are `judgment_receipts` rows,
 * as the ranking writes them), lanes through `createLane` and `attachSession`,
 * operator commands through `recordLaneEvent`, and approvals are persisted in
 * this file's temp data dir. The provider setting is on with a key and the
 * replay is handed the local systemone fixture, so any call would land there;
 * the fixture must see zero requests.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { startJudgmentEndpointFixture, type JudgmentEndpointFixture } from './fixtures/judgment-endpoint';

const originalEnv = {
  CORTEX_IDE_DATA_DIR: process.env.CORTEX_IDE_DATA_DIR,
  O8_DATA_DIR: process.env.O8_DATA_DIR,
  O8_JUDGMENT_API_KEY: process.env.O8_JUDGMENT_API_KEY,
};
const testRoot = mkdtempSync(join(os.tmpdir(), 'o8-replay-catch-up-'));
const dataDir = join(testRoot, 'data');
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_DATA_DIR = dataDir;

const { getSqlite } = await import('@/lib/db');
const { attachSession, createLane } = await import('@/lib/lane/registry');
const { recordLaneEvent } = await import('@/lib/lane/events');
const { recordJudgmentReceipt } = await import('@/lib/judgment/receipts');
const { CATCH_UP_RANKING_SURFACE, catchUpQuestionId } = await import('@/lib/mobile/catch-up-ranking');
const { updateOperatorDefaults } = await import('@/lib/operator/defaults');
const { runReplay } = await import('../scripts/judgment-replay.mjs');

const repoPath = join(testRoot, 'repo');
let fixture: JudgmentEndpointFixture;

function rankingReceipt(items: Array<[string, string, number]>, withSelection = true) {
  recordJudgmentReceipt({
    provider: 'typesafe', model: 'jev-fixture', ok: true, questions: {},
    answers: Object.fromEntries(items.map(([itemId, , score]) => [catchUpQuestionId(itemId), { type: 'noul', noul: score }])),
    inputTokens: 100, outputTokens: 4, latencyMs: 5, attempts: 1, truncated: false, hiddenText: false, error: null,
    packetId: null, laneId: null, approvalId: null, surface: CATCH_UP_RANKING_SURFACE, route: 'direct',
    ...(withSelection ? { selection: { items: items.map(([itemId, kind]) => ({ question: catchUpQuestionId(itemId), itemId, kind })) } } : {}),
  });
}

function approval(id: string, resolvedAt: number, actor: 'desktop' | 'mobile' | 'system') {
  getSqlite().prepare(`
    INSERT INTO approvals (
      id, source, runtime, agent, session_key, title, description, summary,
      risk, status, created_at, updated_at, resolved_at, resolution_json, fingerprint
    ) VALUES (?, 'runtime', 'codex', 'worker', ?, 't', 'd', 's', 'low', 'approved', ?, ?, ?, ?, ?)
  `).run(id, `run:${id}`, Date.now(), Date.now(), resolvedAt, JSON.stringify({ action: 'approved', actor }), `fp-${id}`);
}

function lane(sessionKey: string) {
  const created = createLane({ repoPath, branch: `o8/${sessionKey}`, runtime: 'codex', packetId: `pkt-${sessionKey}` });
  attachSession(created.id, sessionKey);
  return created.id;
}

beforeAll(async () => {
  fixture = await startJudgmentEndpointFixture();
  process.env.O8_JUDGMENT_API_KEY = 'ts-fixture-key-catch-up-label';
  await updateOperatorDefaults({ judgmentProvider: 'typesafe' });

  const acted = lane('sess-acted');
  lane('sess-idle');
  // A receipt from before #2511: no selection, counted and not scored.
  rankingReceipt([['approval:apr-old', 'approval_created', 0.5]], false);
  rankingReceipt([
    ['approval:apr-a', 'approval_created', 0.9],
    ['approval:apr-b', 'approval_created', 0.2],
    ['approval:apr-c', 'approval_created', 0.3],
    ['lane:sess-acted', 'lane_state_change', 0.8],
    ['lane:sess-idle', 'lane_state_change', 0.1],
    ['item:inbox-7', 'watch_fired', 0.5],
  ]);
  const now = Date.now();
  approval('apr-a', now + 5 * 60_000, 'mobile'); // operator, inside the window -> 1
  approval('apr-b', now + 2 * 60 * 60_000, 'desktop'); // operator, after the window -> 0
  approval('apr-c', now + 5 * 60_000, 'system'); // not the operator -> 0
  recordLaneEvent(acted, 'update', 'user', {}); // operator command on the lane -> 1
});

afterAll(async () => {
  vi.restoreAllMocks();
  await fixture.close();
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(testRoot, { recursive: true, force: true });
});

describe('catchUp replay label', () => {
  it('scores each selected item against operator action within 30 minutes of the briefing and sends nothing', async () => {
    const stdout: string[] = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const code = await runReplay(['--label', 'catchUp'], { stdout: (text) => stdout.push(text), stderr: () => undefined, endpoint: fixture.endpoint, retryBaseMs: 1 });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
    expect(fixture.seen).toHaveLength(0);
    const text = stdout.join('\n');
    expect(code).toBe(0);
    expect(text).toContain('catch-up receipts: 2 (failed 0, without selection 1); unlabeled items 1; window 30 min');
    expect(text).toContain('catchUp by p(attention): n=5 scored items (positives 2, negatives 3)  AUC 1.000 (n=5)');
    expect(text).toContain('confound: the score also set the spoken order');
  });
});
