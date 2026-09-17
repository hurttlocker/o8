/**
 * #2434 — the judgment client through its real entry point.
 *
 * Real-path doctrine: the provider setting is written through the real
 * operator-defaults store, the key is read from the data-dir key file, the
 * call goes over HTTP to a local fixture that mimics the systemone endpoint,
 * and receipts are read back from the persisted table and lane events.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { startJudgmentEndpointFixture, type FixtureReply, type SeenRequest } from './fixtures/judgment-endpoint';

const { updateOperatorDefaults } = await import('@/lib/operator/defaults');
const { askJudgment, thresholdAnswer } = await import('@/lib/judgment/client');
const { judgmentKeyPath } = await import('@/lib/judgment/key');
const { DIFF_QUESTIONS } = await import('@/lib/judgment/questions');
const { listJudgmentReceipts } = await import('@/lib/judgment/receipts');
const { buildDiffState } = await import('@/lib/judgment/diff-state');
const { createLane } = await import('@/lib/lane/registry');
const { getSqlite } = await import('@/lib/db');

const KEY = 'ts-fixture-key-7d1c0b5e9a';
const repoPath = mkdtempSync(join(os.tmpdir(), 'o8-judgment-repo-'));

let replies: FixtureReply[] = [];
let seen: SeenRequest[] = [];
let closeFixture: () => Promise<void>;
let endpoint = '';

const QUESTIONS = {
  docsOnly: DIFF_QUESTIONS.docsOnly,
  risk: DIFF_QUESTIONS.risk,
  recommendedAction: DIFF_QUESTIONS.recommendedAction,
};

const SUCCESS_BODY = {
  model: 'jev-1.13.0',
  answers: {
    docsOnly: { type: 'noul', noul: 0.02 },
    risk: {
      type: 'score',
      score: 2.98,
      confidence: 0.96,
      legend: Object.fromEntries(DIFF_QUESTIONS.risk.criteria.map((text, index) => [String(index), text])),
      probabilities: { 0: 0, 1: 0, 2: 0.04, 3: 0.94, 4: 0.02 },
    },
    recommendedAction: {
      type: 'choice',
      choice: 'operatorCard',
      confidence: 0.68,
      probabilities: { operatorCard: 0.78, reject: 0.19, autoApprove: 0.03 },
    },
  },
  usage: { input_tokens: 6253, output_tokens: 193 },
};

const consoleLines: string[] = [];

beforeAll(async () => {
  const fixture = await startJudgmentEndpointFixture();
  ({ replies, seen, endpoint } = fixture);
  closeFixture = fixture.close;

  await updateOperatorDefaults({ judgmentProvider: 'typesafe' });
  writeFileSync(judgmentKeyPath(), `${KEY}\n`);
  chmodSync(judgmentKeyPath(), 0o600);

  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    const original = console[method].bind(console);
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      consoleLines.push(args.map((arg) => (arg instanceof Error ? `${arg.message} ${arg.stack}` : typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
      void original;
    });
  }
});

afterAll(async () => {
  vi.restoreAllMocks();
  await closeFixture();
  rmSync(repoPath, { recursive: true, force: true });
});

beforeEach(() => {
  replies.length = 0;
  seen.length = 0;
});

const fast = () => ({ endpoint, retryBaseMs: 1 });

describe('askJudgment against a local systemone fixture', () => {
  it('returns typed answers and writes a receipt with the exact question text and usage', async () => {
    replies.push({ status: 200, body: SUCCESS_BODY });
    const built = buildDiffState([{ path: 'src/a.ts' }], 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,0 +1,1 @@\n+export const a = 1;');

    const result = await askJudgment(
      { state: built.state, questions: QUESTIONS, context: { packetId: 'pkt-typed', approvalId: 'apr-typed', surface: 'approval-card' } },
      fast(),
    );

    expect(result).not.toBeNull();
    expect(result!.answers.docsOnly.noul).toBe(0.02);
    expect(result!.answers.risk.score).toBe(2.98);
    expect(result!.answers.risk.legend['3']).toBe(DIFF_QUESTIONS.risk.criteria[3]);
    expect(result!.answers.recommendedAction.choice).toBe('operatorCard');
    expect(result!.answers.recommendedAction.probabilities.reject).toBe(0.19);
    expect(result!.usage).toEqual({ inputTokens: 6253, outputTokens: 193 });
    expect(result!.attempts).toBe(1);

    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe('POST');
    expect(seen[0].url).toBe('/v1/systemone');
    expect(seen[0].authorization).toBe(`Bearer ${KEY}`);
    expect(seen[0].body).toEqual({ model: 'jev-latest', state: built.state, questions: QUESTIONS });

    const [receipt] = listJudgmentReceipts({ packetId: 'pkt-typed' });
    expect(receipt.id).toBe(result!.receiptId);
    expect(receipt.ok).toBe(true);
    expect(receipt.model).toBe('jev-1.13.0');
    expect(receipt.questions.docsOnly.instructions).toBe(DIFF_QUESTIONS.docsOnly.instructions);
    expect(receipt.questions).toEqual(QUESTIONS);
    expect(receipt.inputTokens).toBe(6253);
    expect(receipt.outputTokens).toBe(193);
    expect(receipt.approvalId).toBe('apr-typed');
    expect(receipt.surface).toBe('approval-card');
    expect(receipt.truncated).toBe(false);
    expect(receipt.hiddenText).toBe(false);
    expect(receipt.answers).toMatchObject({ recommendedAction: { choice: 'operatorCard' } });
  });

  it('marks choice and score answers under 0.4 confidence as abstain, which thresholds read as null', async () => {
    replies.push({
      status: 200,
      body: {
        ...SUCCESS_BODY,
        answers: {
          ...SUCCESS_BODY.answers,
          risk: { ...SUCCESS_BODY.answers.risk, confidence: 0.39 },
          recommendedAction: { ...SUCCESS_BODY.answers.recommendedAction, confidence: 0.4 },
        },
      },
    });
    const result = await askJudgment({ state: { diff: 'x' }, questions: QUESTIONS, context: { packetId: 'pkt-abstain' } }, fast());
    expect(result).not.toBeNull();
    expect(result!.answers.risk.abstain).toBe(true);
    expect(thresholdAnswer(result!.answers.risk)).toBeNull();
    expect(result!.answers.recommendedAction.abstain).toBe(false);
    expect(thresholdAnswer(result!.answers.recommendedAction)).toBe(result!.answers.recommendedAction);
    expect(thresholdAnswer(result!.answers.docsOnly)).toBe(result!.answers.docsOnly);
    const [receipt] = listJudgmentReceipts({ packetId: 'pkt-abstain' });
    expect(receipt.answers).toMatchObject({ risk: { abstain: true }, recommendedAction: { abstain: false } });
  });

  it('records the hidden-text flag from the built state on the receipt', async () => {
    replies.push({ status: 200, body: SUCCESS_BODY });
    const built = buildDiffState([{ path: 'src/a.ts' }], 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,0 +1,1 @@\n+const is\u200BAdmin = true;');
    expect(built.state.hiddenText).toBe(true);
    await askJudgment({ state: built.state, questions: QUESTIONS, context: { packetId: 'pkt-hidden' } }, fast());
    expect(listJudgmentReceipts({ packetId: 'pkt-hidden' })[0]).toMatchObject({ ok: true, hiddenText: true });
  });

  it('retries a 429 and succeeds on the following 200', async () => {
    replies.push({ status: 429, body: { detail: { error_type: 'rate_limited' } } }, { status: 200, body: SUCCESS_BODY });
    const result = await askJudgment({ state: { diff: 'x' }, questions: QUESTIONS, context: { packetId: 'pkt-429' } }, fast());
    expect(result).not.toBeNull();
    expect(result!.attempts).toBe(2);
    expect(seen).toHaveLength(2);
    const [receipt] = listJudgmentReceipts({ packetId: 'pkt-429' });
    expect(receipt).toMatchObject({ ok: true, attempts: 2 });
  });

  it('returns null after bounded retries on a persistent 5xx and records the failure', async () => {
    for (let i = 0; i < 5; i += 1) replies.push({ status: 529, body: { detail: { error_type: 'overloaded' } } });
    const result = await askJudgment({ state: { diff: 'x' }, questions: QUESTIONS, context: { packetId: 'pkt-5xx' } }, fast());
    expect(result).toBeNull();
    expect(seen).toHaveLength(3);
    const [receipt] = listJudgmentReceipts({ packetId: 'pkt-5xx' });
    expect(receipt).toMatchObject({
      ok: false,
      attempts: 3,
      answers: null,
      model: null,
      error: { kind: 'http', status: 529, errorType: 'overloaded' },
    });
    expect(receipt.questions).toEqual(QUESTIONS);
  });

  it('does not retry an oversized request and records the provider error type', async () => {
    replies.push({ status: 400, body: { detail: { error_type: 'max_tokens_exceeded' } } }, { status: 200, body: SUCCESS_BODY });
    const result = await askJudgment({ state: { diff: 'x' }, questions: QUESTIONS, context: { packetId: 'pkt-400', truncated: true } }, fast());
    expect(result).toBeNull();
    expect(seen).toHaveLength(1);
    const [receipt] = listJudgmentReceipts({ packetId: 'pkt-400' });
    expect(receipt).toMatchObject({ ok: false, attempts: 1, truncated: true, error: { status: 400, errorType: 'max_tokens_exceeded' } });
  });

  it('returns null when an answer does not match its question type', async () => {
    replies.push({ status: 200, body: { ...SUCCESS_BODY, answers: { ...SUCCESS_BODY.answers, docsOnly: { noul: 'yes' } } } });
    const result = await askJudgment({ state: { diff: 'x' }, questions: QUESTIONS, context: { packetId: 'pkt-malformed' } }, fast());
    expect(result).toBeNull();
    expect(listJudgmentReceipts({ packetId: 'pkt-malformed' })[0].error).toMatchObject({ kind: 'malformed' });
  });

  it('times out a hung provider and returns null', async () => {
    replies.push({ status: 200, body: SUCCESS_BODY, delayMs: 500 });
    const result = await askJudgment(
      { state: { diff: 'x' }, questions: QUESTIONS, context: { packetId: 'pkt-timeout' } },
      { endpoint, timeoutMs: 50, maxAttempts: 1 },
    );
    expect(result).toBeNull();
    expect(listJudgmentReceipts({ packetId: 'pkt-timeout' })[0].error).toMatchObject({ kind: 'timeout' });
  });

  it('records a judgment lane event when a lane is in context', async () => {
    const lane = createLane({ repoPath, branch: 'o8/pkt-lane', runtime: 'codex', packetId: 'pkt-lane' });
    replies.push({ status: 200, body: SUCCESS_BODY });
    const result = await askJudgment({ state: { diff: 'x' }, questions: QUESTIONS, context: { packetId: 'pkt-lane', laneId: lane.id } }, fast());
    expect(result).not.toBeNull();
    const rows = getSqlite().prepare("SELECT payload_json FROM lane_events WHERE lane_id = ? AND verb = 'judgment'").all(lane.id) as Array<{ payload_json: string }>;
    expect(rows).toHaveLength(1);
    const payload = JSON.parse(rows[0].payload_json) as Record<string, unknown>;
    expect(payload).toMatchObject({ receiptId: result!.receiptId, ok: true, model: 'jev-1.13.0', inputTokens: 6253, packetId: 'pkt-lane' });
    expect(payload.questions).toEqual(QUESTIONS);
    expect(listJudgmentReceipts({ packetId: 'pkt-lane' })).toEqual([]);
  });

  it('never writes the key to a receipt, a lane event, or a log line', () => {
    const receipts = JSON.stringify(getSqlite().prepare('SELECT * FROM judgment_receipts').all());
    const events = JSON.stringify(getSqlite().prepare("SELECT payload_json FROM lane_events WHERE verb = 'judgment'").all());
    expect(receipts.length).toBeGreaterThan(100);
    expect(consoleLines.some((line) => line.includes('[judgment]'))).toBe(true);
    expect(receipts).not.toContain(KEY);
    expect(events).not.toContain(KEY);
    for (const line of consoleLines) expect(line).not.toContain(KEY);
  });
});
