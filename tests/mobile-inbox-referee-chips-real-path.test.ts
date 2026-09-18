/**
 * #2439 — the docs-only approve chip on phone inbox cards, through the real path.
 *
 * Real-path doctrine: approvals are seeded through the real approvals store,
 * their referee facts are written by the real referee (`startApprovalReferee`)
 * over HTTP to the local judgment endpoint fixture, the setting is written
 * through the operator-defaults store, and every assertion reads what the real
 * `/api/mobile/inbox` and `/api/mobile/action` route handlers return or
 * persist. Nothing calls the chip module directly.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  startJudgmentEndpointFixture,
  writeJudgmentFixtureKey,
  type JudgmentEndpointFixture,
} from './fixtures/judgment-endpoint';

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-inbox-chips-'));
const originalEnv = {
  CORTEX_IDE_DATA_DIR: process.env.CORTEX_IDE_DATA_DIR,
  O8_DATA_DIR: process.env.O8_DATA_DIR,
  HOME: process.env.HOME,
};
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_DATA_DIR = dataDir;
// Runtime discovery reads the home directory's CLI session dirs. Point it at
// the temp dir so the inbox under test holds exactly the seeded approvals.
process.env.HOME = dataDir;

// The action route publishes over WS on success; stub the publisher only.
vi.mock('@/lib/realtime/publisher', () => ({
  publishRealtimeMutation: vi.fn(async () => {}),
}));

const { createApproval, getApproval } = await import('@/lib/approvals/store');
const { setApprovalRefereeOptionsForTests, startApprovalReferee, waitForApprovalReferee } = await import('@/lib/approvals/referee');
const { closeDb, getSqlite } = await import('@/lib/db');
const { DIFF_QUESTIONS } = await import('@/lib/judgment/questions');
const { judgmentKeyPath } = await import('@/lib/judgment/key');
const { invalidateInboxCache } = await import('@/lib/mobile/inbox');
const { clearInboxUrgencyCacheForTests, setInboxUrgencyTransportForTests, waitForInboxUrgency } = await import('@/lib/mobile/inbox-urgency');
const { updateOperatorDefaults } = await import('@/lib/operator/defaults');
const inboxRoute = await import('@/app/api/mobile/inbox/route');
const actionRoute = await import('@/app/api/mobile/action/route');

type InboxItem = {
  id: string;
  approvalId?: string;
  refereeChips?: Array<{ kind: string; probability: number; receiptId: string | null }>;
};

const INBOX_URL = 'http://127.0.0.1:47120/api/mobile/inbox?workspaceReview=0';
const RISK_LEGEND = Object.fromEntries(DIFF_QUESTIONS.risk.criteria.map((text, index) => [String(index), text]));

let fixture: JudgmentEndpointFixture;
let seq = 0;

function diffFor(paths: string[]): string {
  return paths.map((path) => [
    `diff --git a/${path} b/${path}`,
    'index 1111111..2222222 100644',
    `--- a/${path}`,
    `+++ b/${path}`,
    '@@ -1 +1 @@',
    '-old line',
    '+new line',
  ].join('\n')).join('\n');
}

function refereeReply(docsOnly: number) {
  return {
    status: 200,
    body: {
      model: 'jev-1.13.0',
      answers: {
        docsOnly: { type: 'noul', noul: docsOnly },
        touchesMiddlewareOrAuth: { type: 'noul', noul: 0.02 },
        containsPlaceholderOrMockData: { type: 'noul', noul: 0.01 },
        addsTests: { type: 'noul', noul: 0.03 },
        scopeCreepBeyondTitle: { type: 'noul', noul: 0.1 },
        testsReachRealEntryPoint: { type: 'noul', noul: 0.02 },
        risk: { type: 'score', score: 0.2, confidence: 0.9, legend: RISK_LEGEND, probabilities: { 0: 0.8, 1: 0.2, 2: 0, 3: 0, 4: 0 } },
        recommendedAction: { type: 'choice', choice: 'operatorCard', confidence: 0.7, probabilities: { autoApprove: 0.2, operatorCard: 0.7, reject: 0.1 } },
      },
      usage: { input_tokens: 300, output_tokens: 90 },
    },
  };
}

/** A pending merge card whose diff touches `paths`; with `docsOnly`, the real referee stores its facts. */
async function seedCard(tag: string, paths: string[], docsOnly?: number) {
  seq += 1;
  const rawDiff = diffFor(paths);
  const approval = createApproval({
    source: 'test',
    runtime: 'codex',
    agent: 'Codex',
    sessionKey: `codex:chips-${tag}-${seq}`,
    title: `Merge ${tag}`,
    description: `Approve and merge ${tag}.`,
    summary: `merge-${tag}-${seq}`,
    diff: { path: 'multi-file', after: rawDiff, files: paths.map((path) => ({ path, status: 'M' as const, patch: '' })) },
    risk: 'low',
  });
  if (docsOnly !== undefined) {
    fixture.replies.push(refereeReply(docsOnly));
    startApprovalReferee({ approvalId: approval.id, files: paths.map((path) => ({ path })), diffText: rawDiff });
    const stored = await waitForApprovalReferee(approval.id);
    expect(stored?.answers.docsOnly.noul).toBe(docsOnly);
  }
  await new Promise((resolve) => { setTimeout(resolve, 2); });
  return approval;
}

async function readInbox() {
  invalidateInboxCache();
  const response = await inboxRoute.GET(new NextRequest(INBOX_URL));
  const text = await response.text();
  expect(response.status).toBe(200);
  return { text, items: (JSON.parse(text) as { items: InboxItem[] }).items };
}

function post(body: unknown): NextRequest {
  return new NextRequest('http://localhost:3001/api/mobile/action', {
    method: 'POST',
    headers: { host: 'localhost:3001', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function eventRows(approvalId: string) {
  return getSqlite()
    .prepare("SELECT event_type, actor, note, details_json FROM approval_events WHERE approval_id = ? AND event_type = 'approved' ORDER BY timestamp")
    .all(approvalId) as Array<{ event_type: string; actor: string; note: string | null; details_json: string }>;
}

const withoutBuildClock = (text: string) => text.replace(/"generatedAt":"[^"]*"/, '"generatedAt":"<clock>"');

beforeAll(async () => {
  fixture = await startJudgmentEndpointFixture();
  await updateOperatorDefaults({ productTelemetryEnabled: false });
  writeJudgmentFixtureKey(judgmentKeyPath());
});

beforeEach(async () => {
  const sqlite = getSqlite();
  sqlite.prepare('DELETE FROM approval_events').run();
  sqlite.prepare('DELETE FROM approvals').run();
  sqlite.prepare('DELETE FROM judgment_receipts').run();
  clearInboxUrgencyCacheForTests();
  invalidateInboxCache();
  fixture.reset();
  const transport = { endpoint: fixture.endpoint, retryBaseMs: 1, maxAttempts: 1, timeoutMs: 5_000 };
  setApprovalRefereeOptionsForTests(transport);
  // Urgency scoring also runs while the setting is on; its calls hit the
  // exhausted fixture and fail, which leaves every item unscored.
  setInboxUrgencyTransportForTests(transport);
  await updateOperatorDefaults({ judgmentProvider: 'typesafe' });
});

afterAll(async () => {
  await waitForInboxUrgency();
  setApprovalRefereeOptionsForTests(undefined);
  setInboxUrgencyTransportForTests(undefined);
  await fixture.close();
  closeDb();
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(dataDir, { recursive: true, force: true });
});

describe('docs-only chip on phone inbox cards through the real inbox route', () => {
  it('serialises the chip only for an all-docs diff whose stored answer clears the threshold', async () => {
    const docs = await seedCard('docs', ['README.md', 'docs/guide.md'], 0.97);
    const mixed = await seedCard('mixed', ['README.md', 'src/app.ts'], 0.97);
    const below = await seedCard('below', ['docs/notes.md'], 0.85);
    const noFacts = await seedCard('nofacts', ['docs/other.md']);

    const { items } = await readInbox();
    await waitForInboxUrgency();
    const byApproval = new Map(items.map((item) => [item.approvalId, item]));
    const receiptId = getApproval(docs.id)?.referee?.receiptId;
    expect(receiptId).toBeTruthy();

    expect(byApproval.get(docs.id)?.refereeChips).toEqual([{ kind: 'docs-only', probability: 0.97, receiptId }]);
    expect(byApproval.get(mixed.id)).toBeDefined();
    expect(byApproval.get(mixed.id)).not.toHaveProperty('refereeChips');
    expect(byApproval.get(below.id)).not.toHaveProperty('refereeChips');
    expect(byApproval.get(noFacts.id)).not.toHaveProperty('refereeChips');
  }, 60_000);

  it('with the setting off returns the payload byte for byte, the chip step adding nothing', async () => {
    await seedCard('mixed', ['src/app.ts'], 0.97);
    await seedCard('docs', ['README.md'], 0.98);

    const on = await readInbox();
    await waitForInboxUrgency();
    expect(on.text).toContain('"refereeChips"');

    await updateOperatorDefaults({ judgmentProvider: 'off' });
    const off = await readInbox();
    expect(off.text).not.toContain('refereeChips');

    // Same persisted state: the on payload with only the chips removed is the off payload, byte for byte.
    const parsed = JSON.parse(on.text) as { items: Array<Record<string, unknown>> };
    for (const item of parsed.items) delete item.refereeChips;
    expect(withoutBuildClock(off.text)).toBe(withoutBuildClock(JSON.stringify(parsed)));
  }, 60_000);
});

describe('approve from a card with chips through the real action route', () => {
  it('resolves exactly as the plain approve and records the chips-shown fact on the approval event', async () => {
    const chip = await seedCard('chip', ['README.md'], 0.97);
    const plain = await seedCard('plain', ['docs/plain.md'], 0.97);

    const chipRes = await actionRoute.POST(post({ action: 'approve', sessionKey: chip.sessionKey, approvalId: chip.id, via: 'chip' }));
    const plainRes = await actionRoute.POST(post({ action: 'approve', sessionKey: plain.sessionKey, approvalId: plain.id }));
    expect(chipRes.status).toBe(200);
    expect(plainRes.status).toBe(200);
    const chipBody = await chipRes.json() as Record<string, unknown>;
    const plainBody = await plainRes.json() as Record<string, unknown>;
    const comparable = (body: Record<string, unknown>) => ({ ...body, sessionKey: '<key>', clientMutationId: '<id>' });
    expect(comparable(chipBody)).toEqual(comparable(plainBody));

    const chipAfter = getApproval(chip.id)!;
    const plainAfter = getApproval(plain.id)!;
    expect(chipAfter.status).toBe('approved');
    expect(plainAfter.status).toBe('approved');
    expect({ ...chipAfter.resolution, claimId: '<claim>' }).toEqual({ ...plainAfter.resolution, claimId: '<claim>' });

    const chipEvent = chipAfter.audit.at(-1)!;
    const plainEvent = plainAfter.audit.at(-1)!;
    expect(chipEvent).toMatchObject({ type: 'approved', actor: 'mobile', approvedFromCard: { via: 'chip', chipsShown: ['docs-only'] } });
    const { approvedFromCard: _fact, ...chipEventRest } = chipEvent;
    expect({ ...chipEventRest, timestamp: 0 }).toEqual({ ...plainEvent, timestamp: 0 });
    // Without `via`, the event is today's: no extra key at all.
    expect(Object.keys(plainEvent).sort()).toEqual(['actor', 'timestamp', 'type']);

    const [chipRow] = eventRows(chip.id);
    const [plainRow] = eventRows(plain.id);
    expect(chipRow).toMatchObject({ event_type: 'approved', actor: 'mobile' });
    expect(JSON.parse(chipRow.details_json)).toEqual({ approvedFromCard: { via: 'chip', chipsShown: ['docs-only'] } });
    expect(plainRow).toEqual({ event_type: 'approved', actor: 'mobile', note: null, details_json: '{}' });
  }, 60_000);

  it('ignores an unknown via value', async () => {
    const card = await seedCard('unknown', ['README.md'], 0.97);
    const res = await actionRoute.POST(post({ action: 'approve', sessionKey: card.sessionKey, approvalId: card.id, via: 'swipe' }));
    expect(res.status).toBe(200);
    expect(getApproval(card.id)!.audit.at(-1)).not.toHaveProperty('approvedFromCard');
    expect(eventRows(card.id)[0].details_json).toBe('{}');
  }, 60_000);
});
