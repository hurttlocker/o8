/**
 * #2443 — fuzzy Symon watches, driven through the seams a real operator
 * reaches: the watch registration route, the durable scheduler tick, the
 * judgment client over HTTP to the local endpoint fixture, the Symon watch
 * ledger, and the phone's watch list route.
 *
 * No Symon session is live, so a fire parks; "fired" here means the tick
 * persisted a fire row and ran the Symon action for it, the same path an exact
 * watch takes.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { startJudgmentEndpointFixture, type JudgmentEndpointFixture } from './fixtures/judgment-endpoint';

const dataDir = mkdtempSync(join(tmpdir(), 'o8-fuzzy-watch-data-'));
const repoPath = mkdtempSync(join(tmpdir(), 'o8-fuzzy-watch-repo-'));
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_DATA_DIR = dataDir;
const OPERATOR_TOKEN = 'fuzzy-watch-operator-token-2443-abcdef';
writeFileSync(join(dataDir, 'ws-token'), `${OPERATOR_TOKEN}\n`, 'utf-8');

/** A closed port: the Symon delivery bridge fails fast and the fire parks. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('missing test port'));
      server.close(() => resolve(address.port));
    });
  });
}
process.env.O8_WS_PORT = String(await freePort());
process.env.O8_API_PORT = String(await freePort());

const watchesRoute = await import('@/app/api/symon/watches/route');
const mobileWatchesRoute = await import('@/app/api/mobile/symon/watches/route');
const { getSqlite, closeDb } = await import('@/lib/db');
const { createLane } = await import('@/lib/lane/registry');
const { recordLaneEvent } = await import('@/lib/lane/events');
const { listAutomationFires } = await import('@/lib/automations/fire-store');
const { runAutomationSchedulerTick } = await import('@/lib/automations/scheduler');
const { setFuzzyWatchTransportForTests, FUZZY_WATCH_REFUSAL } = await import('@/lib/automations/fuzzy-watch');
const { readSymonWatchLedger, closeSymonWatchLedger } = await import('@/lib/automations/symon-watch-ledger');
const { updateOperatorDefaults } = await import('@/lib/operator/defaults');
const { judgmentKeyPath } = await import('@/lib/judgment/key');

const KEY = 'ts-fixture-key-fuzzy-watch-2443';
const PACKET_TITLE = 'Polish the settings card title text';
const PR_BODY = 'PR body text that must never reach the referee';
const CONDITION = 'tell me when that PR looks ready to merge';

let fixture: JudgmentEndpointFixture;

function noul(p: number) {
  return { status: 200, body: { model: 'jev-1.13.0', answers: { conditionMet: { noul: p } }, usage: { input_tokens: 300, output_tokens: 4 } } };
}

async function createWatch(input: { packetId: string; fuzzy: boolean; text?: string; events?: string[] }) {
  return watchesRoute.POST(new Request('http://localhost/api/symon/watches', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sessionId: 'symon-fuzzy-session',
      condition: {
        text: input.text ?? CONDITION,
        source: 'packet',
        id: input.packetId,
        events: input.events ?? [],
        repoPath,
        ...(input.fuzzy ? { fuzzy: true } : {}),
      },
      then: { kind: 'report', say: 'That PR looks ready.' },
    }),
  }));
}

async function createFuzzyWatch(packetId: string): Promise<string> {
  const response = await createWatch({ packetId, fuzzy: true });
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json() as { watch: { id: string } }).watch.id;
}

/** A packet with a lane, a PR row carrying a title and body, and one lane event. */
function seedPacket(packetId: string) {
  const lane = createLane({ repoPath, branch: `packet/${packetId}`, baseBranch: 'main', runtime: 'codex', packetId, label: PACKET_TITLE });
  const sqlite = getSqlite();
  sqlite.prepare('UPDATE lanes SET pr_number = 77 WHERE id = ?').run(lane.id);
  sqlite.prepare(`
    INSERT OR REPLACE INTO github_pull_requests (pull_request_id, repo_full_name, number, title, state, body, head_ref_name, review_decision, status_checks_json, url, updated_at)
    VALUES (9001, 'acme/app', 77, ?, 'OPEN', ?, ?, 'APPROVED', ?, 'https://example.test/pr/77', datetime('now'))
  `).run(PACKET_TITLE, PR_BODY, `packet/${packetId}`, JSON.stringify([{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }]));
  recordLaneEvent(lane.id, 'update', 'system', { eventLabel: 'review_requested' });
  return lane;
}

let clock = Date.now();
function tick() {
  clock += 30_000;
  return runAutomationSchedulerTick({ nowMs: clock, workerId: 'fuzzy-watch-worker', concurrencyCap: 1, maxClaims: 4 });
}

const fired = (watchId: string) => listAutomationFires(watchId).length > 0;
const evaluations = (watchId: string) => readSymonWatchLedger(watchId, 50).filter((event) => event.phase === 'watch_evaluated');

beforeAll(async () => {
  await updateOperatorDefaults({ productTelemetryEnabled: false });
  fixture = await startJudgmentEndpointFixture();
  setFuzzyWatchTransportForTests({ endpoint: fixture.endpoint, timeoutMs: 2_000, maxAttempts: 1 });
  writeFileSync(judgmentKeyPath(), `${KEY}\n`);
  chmodSync(judgmentKeyPath(), 0o600);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

beforeEach(async () => {
  fixture.reset();
  await updateOperatorDefaults({ judgmentProvider: 'typesafe' });
  const sqlite = getSqlite();
  for (const table of ['automation_fires', 'automations', 'automation_source_events', 'automation_source_ingest_state', 'lane_events', 'lanes', 'github_pull_requests']) {
    sqlite.prepare(`DELETE FROM ${table}`).run();
  }
  sqlite.prepare("DELETE FROM cloud_jobs WHERE team_id = 'automation'").run();
});

afterAll(async () => {
  setFuzzyWatchTransportForTests(undefined);
  vi.restoreAllMocks();
  await fixture.close();
  closeSymonWatchLedger();
  closeDb();
  rmSync(repoPath, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

describe('fuzzy Symon watches through the real route and scheduler tick', () => {
  it('fires on the tick after the condition first holds, not on that tick', async () => {
    seedPacket('pkt-ready');
    const watchId = await createFuzzyWatch('pkt-ready');
    fixture.replies.push(noul(0.1), noul(0.9), noul(0.9));

    await tick();
    expect(fired(watchId)).toBe(false);
    await tick();
    expect(fired(watchId), 'not fired after tick 2').toBe(false);
    const third = await tick();
    expect(fired(watchId), 'fired after tick 3').toBe(true);
    expect(third.completed[0]).toMatchObject({ source: 'watch', actionKind: 'symon_report', sourceEventType: 'condition_met' });

    const evaluated = evaluations(watchId);
    expect(evaluated).toHaveLength(3);
    for (const event of evaluated) expect(event.summary).toMatch(/receipt=(?!none)\S+/);
    expect(evaluated[0].outcome).toBe('condition_met');
    const receipts = getSqlite().prepare("SELECT payload_json FROM lane_events WHERE verb = 'judgment'").all() as Array<{ payload_json: string }>;
    expect(receipts.map((row) => JSON.parse(row.payload_json).surface)).toEqual(['fuzzy-watch', 'fuzzy-watch', 'fuzzy-watch']);
  }, 30_000);

  it('never fires on a flickering answer', async () => {
    seedPacket('pkt-flicker');
    const watchId = await createFuzzyWatch('pkt-flicker');
    fixture.replies.push(noul(0.9), noul(0.2), noul(0.9), noul(0.3));
    for (let index = 0; index < 4; index += 1) await tick();
    expect(fixture.seen).toHaveLength(4);
    expect(fired(watchId)).toBe(false);
    expect(evaluations(watchId)).toHaveLength(4);
  }, 30_000);

  it('serialises the last answer on the phone watch list after the first tick', async () => {
    seedPacket('pkt-phone');
    const watchId = await createFuzzyWatch('pkt-phone');
    fixture.replies.push(noul(0.72));
    await tick();
    const response = await mobileWatchesRoute.GET(new NextRequest('http://localhost/api/mobile/symon/watches', {
      headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
    }));
    expect(response.status).toBe(200);
    const { watches } = await response.json() as { watches: Array<{ id: string; lastAnswer?: { p: number; at: number } }> };
    expect(watches.find((watch) => watch.id === watchId)?.lastAnswer).toEqual({ p: 0.72, at: clock });
  }, 30_000);

  it('sends the condition and o8-computed facts, never the packet title or PR body', async () => {
    seedPacket('pkt-state');
    await createFuzzyWatch('pkt-state');
    fixture.replies.push(noul(0.5));
    await tick();
    expect(fixture.seen).toHaveLength(1);
    const body = fixture.seen[0].body as { state: { condition: string; facts: Record<string, unknown> }; questions: Record<string, { instructions: string }> };
    expect(body.questions.conditionMet.instructions).toBe('Given the current facts, is the condition satisfied?');
    expect(body.state.condition).toBe(CONDITION);
    expect(body.state.facts).toMatchObject({
      sourceKind: 'packet',
      sourceId: 'pkt-state',
      lane: { status: expect.any(String), pullRequest: { number: 77, state: 'OPEN', merged: false, reviewDecision: 'APPROVED', checks: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }] } },
      recentEvents: [{ type: 'open_lane', ageMs: expect.any(Number) }, { type: 'review_requested', ageMs: expect.any(Number) }],
    });
    const raw = JSON.stringify(fixture.seen[0].body);
    expect(raw).not.toContain(PACKET_TITLE);
    expect(raw).not.toContain(PR_BODY);
  }, 30_000);

  it('with the setting off refuses a fuzzy watch, creates nothing, and leaves exact watches unchanged', async () => {
    await updateOperatorDefaults({ judgmentProvider: 'off' });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const refused = await createWatch({ packetId: 'pkt-off', fuzzy: true });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: FUZZY_WATCH_REFUSAL });
    expect(getSqlite().prepare('SELECT COUNT(*) AS n FROM automations').get()).toEqual({ n: 0 });

    // Exact watch baseline: the tick's result is the same as a tick with no fuzzy pass at all.
    const exact = await createWatch({ packetId: 'pkt-exact', fuzzy: false, text: 'tell me when pkt-exact asks for review', events: ['review_requested'] });
    expect(exact.status).toBe(200);
    const exactId = (await exact.json() as { watch: { id: string } }).watch.id;
    seedPacket('pkt-exact');
    const result = await tick();
    expect(result.materialized.map((fire) => [fire.automationId, fire.sourceEventType])).toEqual([[exactId, 'review_requested']]);
    expect(result.completed).toHaveLength(1);
    expect(fixture.seen).toHaveLength(0);
    expect(fetchSpy.mock.calls.map(([url]) => String(url)).filter((url) => url.startsWith(fixture.endpoint))).toEqual([]);
    expect(evaluations(exactId)).toHaveLength(0);
    fetchSpy.mockRestore();
  }, 30_000);
});
