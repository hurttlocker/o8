/**
 * #2447, #2446 — the claimUnbacked and directiveCitation replay labels, and
 * `--label all-recorded`, through `runReplay`.
 *
 * Real-path doctrine: lanes go through `createLane`, status changes through
 * `setLaneStatus`, receipts through the real `recordJudgmentReceipt` (which
 * writes a `judgment` lane event when a lane is in context), citation records
 * through `recordLaneEvent`, and approvals and outcome rows are persisted in
 * this file's temp data dir. The provider setting is on with a key and the
 * replay is handed the local systemone fixture as its endpoint, so any call
 * would land there; the fixture must see zero requests in every case.
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
const testRoot = mkdtempSync(join(os.tmpdir(), 'o8-replay-recorded-'));
const dataDir = join(testRoot, 'data');
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_DATA_DIR = dataDir;

const { getSqlite } = await import('@/lib/db');
const { createLane, setLaneStatus } = await import('@/lib/lane/registry');
const { recordLaneEvent } = await import('@/lib/lane/events');
const { recordJudgmentReceipt } = await import('@/lib/judgment/receipts');
const { approvalDiffFingerprint } = await import('@/lib/approvals/referee');
const { REPORT_CLAIM_CHECK_SURFACE } = await import('@/lib/lane/report-claim-check');
const { updateOperatorDefaults } = await import('@/lib/operator/defaults');
const { runReplay } = await import('../scripts/judgment-replay.mjs');

const repoPath = join(testRoot, 'repo');
let fixture: JudgmentEndpointFixture;

const noul = (value: number) => ({ type: 'noul', noul: value });

function lane(packetId: string) {
  const created = createLane({ repoPath, branch: `o8/${packetId}`, runtime: 'codex', packetId });
  setLaneStatus(created.id, 'running', 'orchestrator', 'session_launched');
  return created.id;
}

function claimReceipt(laneId: string, packetId: string, testsRun: number, filesNotInDiff: number) {
  recordJudgmentReceipt({
    provider: 'typesafe', model: 'jev-fixture', ok: true, questions: {},
    answers: {
      claimsTestsRun: noul(testsRun),
      evidenceShowsTestsRun: noul(0.5),
      claimsFilesNotInDiff: noul(filesNotInDiff),
      claimsVerifiedRealPath: noul(0.5),
    },
    inputTokens: 100, outputTokens: 4, latencyMs: 5, attempts: 1, truncated: false, hiddenText: false, error: null,
    packetId, laneId, approvalId: null, surface: REPORT_CLAIM_CHECK_SURFACE, route: 'direct',
  });
}

function citations(laneId: string, packetId: string, diffFingerprint: string, scores: Array<[string, number, boolean?]>) {
  recordLaneEvent(laneId, 'directive_citations', 'system', {
    packetId,
    diffFingerprint,
    recipe: 'critical-rules-never-v1',
    scores: scores.map(([rule, probability, heldBack]) => ({
      ruleId: `spec-ingest:repo:claude-md:critical-rules#${rule}`,
      directiveId: 'spec-ingest:repo:claude-md:critical-rules',
      path: 'src/components/A.tsx',
      probability,
      receiptId: null,
      ...(heldBack ? { heldBack: true } : {}),
    })),
  });
}

function approval(id: string, packetId: string, laneId: string, file: string, status: 'approved' | 'rejected', actor: 'desktop' | 'mobile') {
  const after = `diff --git a/${file} b/${file}\n+${id}`;
  const resolvedAt = Date.now() + 60_000;
  getSqlite().prepare(`
    INSERT INTO approvals (
      id, source, runtime, agent, session_key, title, description, summary, diff_json,
      risk, packet_id, lane_id, status, created_at, updated_at, resolved_at, resolution_json, fingerprint
    ) VALUES (?, 'runtime', 'codex', 'worker', ?, 't', 'd', 's', ?, 'low', ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, `lane:${laneId}`, JSON.stringify({ path: 'multi-file', after, files: [{ path: file, status: 'M' }] }),
    packetId, laneId, status, Date.now(), Date.now(), resolvedAt, JSON.stringify({ action: status, actor }), `fp-${id}`);
  return approvalDiffFingerprint(after, [file]);
}

function mergedOutcome(packetId: string) {
  const at = new Date().toISOString();
  getSqlite().prepare(`
    INSERT INTO session_outcomes (id, repo_path, runtime, packet_id, outcome, summary, started_at, completed_at, merged_clean)
    VALUES (?, ?, 'codex', ?, 'succeeded', 'done', ?, ?, 1)
  `).run(`out-${packetId}`, repoPath, packetId, at, at);
}

beforeAll(async () => {
  fixture = await startJudgmentEndpointFixture();
  process.env.O8_JUDGMENT_API_KEY = 'ts-fixture-key-recorded-labels';
  await updateOperatorDefaults({ judgmentProvider: 'typesafe' });

  // Every lane launched once BEFORE its report; that launch must not count as a rerun.
  const l1 = lane('pkt-1');
  const l2 = lane('pkt-2');
  const l3 = lane('pkt-3');
  const l4 = lane('pkt-4');
  const l5 = lane('pkt-5');
  const l6 = lane('pkt-6');

  // pkt-1: report, citations, then a rerun launches a replacement lane -> y=1.
  claimReceipt(l1, 'pkt-1', 0.9, 0.8);
  citations(l1, 'pkt-1', 'fp-pkt-1', [['css-classes', 0.9], ['hardcoded-ports', 0.4]]);
  lane('pkt-1');
  // pkt-2: report, citations, then merged -> y=0.
  claimReceipt(l2, 'pkt-2', 0.2, 0.1);
  citations(l2, 'pkt-2', 'fp-pkt-2', [['css-classes', 0.7], ['hardcoded-ports', 0.2], ['css-shorthand', 0.65, true]]);
  setLaneStatus(l2, 'completed', 'system', 'merged');
  // pkt-3: report and citations, then the phone rejected its approval -> y=1.
  claimReceipt(l3, 'pkt-3', 0.7, 0.3);
  citations(l3, 'pkt-3', 'fp-pkt-3', [['throw-in-api-routes', 0.8]]);
  approval('apr-3', 'pkt-3', l3, 'src/app/api/x/route.ts', 'rejected', 'mobile');
  // pkt-4: report, merged per the outcome ledger -> y=0.
  claimReceipt(l4, 'pkt-4', 0.1, 0.6);
  mergedOutcome('pkt-4');
  // pkt-5: report, nothing after -> unlabeled.
  claimReceipt(l5, 'pkt-5', 0.5, 0.5);
  // pkt-6: citations for a diff whose own approval was approved; a later
  // diff's approval was rejected; merged. The fingerprint match keeps y=0.
  const approvedDiff = approval('apr-6a', 'pkt-6', l6, 'src/ui/B.tsx', 'approved', 'desktop');
  approval('apr-6b', 'pkt-6', l6, 'src/ui/C.tsx', 'rejected', 'desktop');
  citations(l6, 'pkt-6', approvedDiff, [['rgba-surfaces', 0.3]]);
  mergedOutcome('pkt-6');
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

async function replay(argv: string[]) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const fetchSpy = vi.spyOn(globalThis, 'fetch');
  const code = await runReplay(argv, { stdout: (text) => stdout.push(text), stderr: (text) => stderr.push(text), endpoint: fixture.endpoint, retryBaseMs: 1 });
  expect(fetchSpy).not.toHaveBeenCalled();
  fetchSpy.mockRestore();
  expect(fixture.seen).toHaveLength(0);
  return { code, text: stdout.join('\n'), stderr: stderr.join('\n') };
}

describe('recorded-answer replay labels', () => {
  it('claimUnbacked scores both recorded claim answers against a later rerun or rejection versus a merge', async () => {
    const { code, text } = await replay(['--label', 'claimUnbacked']);
    expect(code).toBe(0);
    expect(text).toContain('report-claim receipts: 5 (failed calls 0, unlabeled 1); labeled reports: rerun after 1, rejected after 1, merged without either 2');
    expect(text).toContain('claimUnbacked by claimsTestsRun: n=4 labeled reports (positives 2, negatives 2)  AUC 1.000 (n=4)');
    expect(text).toContain('claimUnbacked by claimsFilesNotInDiff: n=4 labeled reports (positives 2, negatives 2)  AUC 0.750 (n=4)');
  });

  it('directiveCitation scores each (file, rule) and prints false citations per rule at 0.6', async () => {
    const { code, text } = await replay(['--label', 'directiveCitation']);
    expect(code).toBe(0);
    expect(text).toContain('directive_citations events: 4 (unlabeled 0, approval matched by diff fingerprint 1); scores read: 7');
    expect(text).toContain('directiveCitation by p(breaks rule): n=7 labeled scores (positives 3, negatives 4)');
    expect(text).toMatch(/^ {2}AUC \d\.\d{3} \(n=7\)/m);
    expect(text).toContain('false citations at p >= 0.6: 2 of 4 y=0 scores');
    expect(text).toContain('rule css-classes: n=2, positives 1, cited positives 1, false citations 1 of 1 y=0');
    expect(text).toContain('rule css-shorthand (held back): n=1, positives 0, cited positives 0, false citations 1 of 1 y=0');
    expect(text).toContain('rule rgba-surfaces: n=1, positives 0, cited positives 0, false citations 0 of 1 y=0');
    expect(text).toContain('rule throw-in-api-routes: n=1, positives 1, cited positives 1, false citations 0 of 0 y=0');
  });

  it('all-recorded runs every recorded label once, never the calling labels, and spends nothing', async () => {
    const { code, text } = await replay(['--label', 'all-recorded']);
    expect(code).toBe(0);
    for (const label of ['compaction', 'pushGate', 'loop', 'wakeTriage', 'claimUnbacked', 'directiveCitation', 'catchUp']) {
      expect(text.match(new RegExp(`^== ${label} ==$`, 'gm'))).toHaveLength(1);
    }
    expect(text).toMatch(/claimUnbacked by claimsTestsRun: .*AUC 1\.000/);
    expect(text).toMatch(/^ {2}AUC \d\.\d{3} \(n=7\)/m);
    expect(text).toContain('rule css-classes: n=2');
    expect(text).toContain('recorded labels: compaction 0 rows, pushGate 0 rows, loop 0 rows, wakeTriage 0 rows, claimUnbacked 8 rows, directiveCitation 7 rows, catchUp 0 rows');
    expect(text).toContain('total spend: $0.000000, no provider calls');
    for (const calling of ['gateFailed', 'operatorRejected', 'mergedClean', 'calls:']) expect(text).not.toContain(calling);
  });

  it('rejects an unknown label', async () => {
    const { code, stderr } = await replay(['--label', 'noSuchLabel']);
    expect(code).toBe(1);
    expect(stderr).toContain('unknown label: noSuchLabel');
  });
});
