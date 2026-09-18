/**
 * #2444 — catch-up ranking of the phone briefing, through the real session mint.
 *
 * Real-path doctrine: every assertion drives the real POST handler of
 * `/api/mobile/symon/session` and reads the instructions it sends to the
 * realtime mint plus the JSON it returns. The setting goes through the real
 * operator-defaults store, the key comes from the data-dir key file, the
 * ranking call goes over HTTP to the local judgment endpoint fixture, and
 * receipts are read back from the persisted `judgment_receipts` table.
 * Stubbed, as in the colocated route test: the inbox snapshot source, the
 * webview bridge, credentials, auth, and the upstream realtime mint.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  startJudgmentEndpointFixture,
  writeJudgmentFixtureKey,
  type JudgmentEndpointFixture,
} from './fixtures/judgment-endpoint';
import type { MobileApprovalCard } from '@/lib/approvals/types';
import type { MobileInboxSnapshot } from '@/lib/mobile/types';

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-catch-up-ranking-'));
const originalEnv = {
  CORTEX_IDE_DATA_DIR: process.env.CORTEX_IDE_DATA_DIR,
  O8_DATA_DIR: process.env.O8_DATA_DIR,
  CODEX_HOME: process.env.CODEX_HOME,
};
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_DATA_DIR = dataDir;
process.env.CODEX_HOME = dataDir;

const h = vi.hoisted(() => ({
  evalJs: vi.fn<(code: string) => Promise<{ result: string }>>(),
  inboxSnapshot: { value: null as unknown },
  /** Baseline switch: behave as if the mint never called the ranking. */
  withoutRanking: false,
}));

vi.mock('@/lib/mobile/inbox', () => ({ getMobileInboxSnapshot: async () => h.inboxSnapshot.value }));
vi.mock('@/lib/mcp/o8-webview-client', () => ({ O8WebviewClient: class { evalJs = h.evalJs; } }));
vi.mock('@/lib/cortex/qa/llm/byok-keys', () => ({ resolveOpenAIKey: async () => 'sk-test-key' }));
vi.mock('@/lib/voice/realtime-access', () => ({
  resolveRealtimeAccess: async () => ({ mode: 'byok', available: true, reason: 'byok' }),
}));
vi.mock('@/lib/auth/principal', () => ({ resolveRequestPrincipal: () => 'operator' }));
vi.mock('@/lib/panel/auth', () => ({ requirePanelAuth: () => null }));
vi.mock('@/lib/mobile/device-registry', () => ({ resolveDeviceByToken: () => null }));
vi.mock('@/lib/mobile/symon-agent-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/mobile/symon-agent-registry')>()),
  persistSymonScopeGrant: () => undefined,
}));
vi.mock('@/lib/mobile/catch-up-ranking', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/mobile/catch-up-ranking')>();
  return {
    ...actual,
    rankPhoneBriefing: (...args: Parameters<typeof actual.rankPhoneBriefing>) => (
      h.withoutRanking ? Promise.resolve(null) : actual.rankPhoneBriefing(...args)
    ),
  };
});

const { closeDb, getSqlite } = await import('@/lib/db');
const { updateOperatorDefaults } = await import('@/lib/operator/defaults');
const { judgmentKeyPath } = await import('@/lib/judgment/key');
const { listJudgmentReceipts } = await import('@/lib/judgment/receipts');
const { CATCH_UP_QUESTION } = await import('@/lib/judgment/questions');
const { PHONE_O8_TOOL_NAMES } = await import('@/lib/voice/realtime-session-config');
const { PHONE_BRIEFING_END, PHONE_BRIEFING_START } = await import('@/lib/mobile/symon-briefing');
const {
  CATCH_UP_RANKING_SURFACE,
  catchUpQuestionId,
  setCatchUpRankingTransportForTests,
} = await import('@/lib/mobile/catch-up-ranking');
const { POST } = await import('@/app/api/mobile/symon/session/route');

/** Every operator-visible string carries this, so one scan proves none of it was sent. */
const TITLE_TEXT = 'ripcord-title-prose';
const REPO_TEXT = 'ripcord-repo-name';
const OPENAI_MINT = 'api.openai.com';
const FIXTURE_SCORES = [0.2, 0.9, 0.5, 0.9, 0.1];
const APPROVAL_IDS = ['apr-1', 'apr-2', 'apr-3', 'apr-4', 'apr-5'];
const ITEM_IDS = APPROVAL_IDS.map((id) => `approval:${id}`);

let fixture: JudgmentEndpointFixture;
const realFetch = globalThis.fetch;
let minted: Array<Record<string, unknown>> = [];

function approval(id: string, index: number): MobileApprovalCard {
  return {
    id,
    sessionKey: `run:${id}`,
    agent: 'builder',
    severity: 'warning',
    title: `${TITLE_TEXT} ${index}`,
    description: `${TITLE_TEXT} description ${index}`,
    repo: `${REPO_TEXT}-${index % 2}`,
    actions: { approve: { label: 'Approve' }, reject: { label: 'Reject' } },
    createdAt: 1_700_000_000_000 + index,
  };
}

function snapshot(): MobileInboxSnapshot {
  return {
    generatedAt: '2026-09-18T12:00:00.000Z',
    mode: 'live',
    sourceLabel: 'fixture desktop',
    sessions: [],
    fleetSessions: [],
    approvals: APPROVAL_IDS.map(approval),
    reviewUnits: [],
    items: [],
    summary: { alerts: 0, approvals: 5, reviewItems: 0, activeRuns: 0 },
  } as MobileInboxSnapshot;
}

function scoreReply(scores: number[]) {
  return {
    status: 200,
    body: {
      model: 'jev-1.13.0',
      answers: Object.fromEntries(ITEM_IDS.map((id, index) => [catchUpQuestionId(id), { type: 'noul', noul: scores[index] }])),
      usage: { input_tokens: 200, output_tokens: 20 },
    },
  };
}

/** Mint once; returns the instructions sent upstream and the parsed route JSON. */
async function mint() {
  minted = [];
  const response = await POST(new NextRequest('http://localhost:3001/api/mobile/symon/session', {
    method: 'POST',
    headers: { host: 'localhost:3001', 'content-type': 'application/json' },
    body: '{}',
  }));
  expect(response.status).toBe(200);
  const text = await response.text();
  expect(minted).toHaveLength(1);
  const upstream = JSON.stringify(minted[0]);
  const instructions = (minted[0].session as { instructions: string }).instructions;
  return { text, json: JSON.parse(text) as Record<string, unknown>, upstream, instructions };
}

/** Approval ids in the order the briefing block lists them. */
function briefingApprovalOrder(instructions: string): string[] {
  const block = instructions.slice(instructions.indexOf(PHONE_BRIEFING_START), instructions.indexOf(PHONE_BRIEFING_END));
  return block.split('\n').filter((line) => line.startsWith('- approval ')).map((line) => /id=(\S+)/.exec(line)![1]);
}

/** The session id and secret are minted per call; everything else must match. */
const stable = (text: string) => text.replace(/"sessionId":"[^"]*"/g, '"sessionId":"<id>"');

beforeAll(async () => {
  fixture = await startJudgmentEndpointFixture();
  await updateOperatorDefaults({ productTelemetryEnabled: false });
  writeJudgmentFixtureKey(judgmentKeyPath());
});

beforeEach(async () => {
  getSqlite().prepare('DELETE FROM judgment_receipts').run();
  fixture.reset();
  h.withoutRanking = false;
  h.inboxSnapshot.value = snapshot();
  delete (globalThis as { __o8BrowserAgentClient?: unknown }).__o8BrowserAgentClient;
  const tools = PHONE_O8_TOOL_NAMES.map((name) => ({ type: 'function', name, parameters: { type: 'object', properties: {}, required: [] } }));
  h.evalJs.mockReset();
  h.evalJs.mockImplementation(async (code: string) => (
    code.includes('deskWasLive')
      ? { result: JSON.stringify({ deskWasLive: false }) }
      : { result: JSON.stringify({ ready: true, tools, voice: 'marin' }) }
  ));
  // Only the upstream realtime mint is stubbed; the judgment fixture gets the real fetch.
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes(OPENAI_MINT)) {
      minted.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return { ok: true, status: 200, json: async () => ({ value: 'ek_catch_up', expires_at: 1 }) } as Response;
    }
    return realFetch(input, init);
  });
  setCatchUpRankingTransportForTests({ endpoint: fixture.endpoint, maxAttempts: 1, retryBaseMs: 1, timeoutMs: 5_000 });
  await updateOperatorDefaults({ judgmentProvider: 'off' });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  setCatchUpRankingTransportForTests(undefined);
  await fixture.close();
  closeDb();
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(dataDir, { recursive: true, force: true });
});

describe('catch-up ranking through the real phone Symon mint', () => {
  it('orders the briefing by score with ties in event order, and returns the scores and receipt', async () => {
    fixture.replies.push(scoreReply(FIXTURE_SCORES));
    await updateOperatorDefaults({ judgmentProvider: 'typesafe' });

    const { json, instructions } = await mint();

    expect(briefingApprovalOrder(instructions)).toEqual(['apr-2', 'apr-4', 'apr-3', 'apr-1', 'apr-5']);
    const receipts = listJudgmentReceipts({ limit: 10 });
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ ok: true, surface: CATCH_UP_RANKING_SURFACE });
    expect(json.briefing).toEqual({
      advisory: {
        scores: Object.fromEntries(ITEM_IDS.map((id, index) => [id, FIXTURE_SCORES[index]])),
        receiptId: receipts[0].id,
        truncated: false,
      },
    });
  });

  it('sends one call with five question keys and no title, description, or repo name', async () => {
    fixture.replies.push(scoreReply(FIXTURE_SCORES));
    await updateOperatorDefaults({ judgmentProvider: 'typesafe' });

    await mint();

    expect(fixture.seen).toHaveLength(1);
    const body = fixture.seen[0].body as { questions: Record<string, { instructions: string }>; state: { items: unknown[] } };
    expect(Object.keys(body.questions).sort()).toEqual(ITEM_IDS.map(catchUpQuestionId).sort());
    expect(Object.values(body.questions).every((question) => question.instructions === CATCH_UP_QUESTION.instructions)).toBe(true);
    expect(body.state.items).toHaveLength(5);
    const sent = JSON.stringify(body);
    expect(sent).not.toContain(TITLE_TEXT);
    expect(sent).not.toContain(REPO_TEXT);
  });

  it('keeps event order on a provider failure, records the failure receipt, and still mints', async () => {
    fixture.replies.push({ status: 500, body: { detail: { error_type: 'fixture_down' } } });
    await updateOperatorDefaults({ judgmentProvider: 'typesafe' });

    const { json, instructions } = await mint();

    expect(briefingApprovalOrder(instructions)).toEqual(APPROVAL_IDS);
    expect(json.briefing).toBeUndefined();
    const receipts = listJudgmentReceipts({ limit: 10 });
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ ok: false, surface: CATCH_UP_RANKING_SURFACE });
  });

  it('with the setting off, the upstream body and the response are byte-identical to the unranked mint, with zero requests', async () => {
    h.withoutRanking = true;
    const baseline = await mint();
    h.withoutRanking = false;
    const off = await mint();

    expect(off.upstream).toBe(baseline.upstream);
    expect(stable(off.text)).toBe(stable(baseline.text));
    expect(briefingApprovalOrder(off.instructions)).toEqual(APPROVAL_IDS);
    expect(fixture.seen).toHaveLength(0);
    expect(listJudgmentReceipts({ limit: 10 })).toHaveLength(0);
  });
});
