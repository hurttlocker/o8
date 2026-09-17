/**
 * #2438 — the calibration replay through its real entry points.
 *
 * Real-path doctrine: approvals, lane events, and outcome rows are persisted
 * through the product's migrated database in this worker's temp
 * CORTEX_IDE_DATA_DIR; the replay reads them back read-only, the provider
 * setting goes through the operator-defaults store, calls go over HTTP to a
 * local fixture shaped like the systemone endpoint, and receipts are read back
 * from the persisted table. One case runs the command line itself.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { updateOperatorDefaults } = await import('@/lib/operator/defaults');
const { DIFF_QUESTIONS } = await import('@/lib/judgment/questions');
const { listJudgmentReceipts } = await import('@/lib/judgment/receipts');
const { createLane } = await import('@/lib/lane/registry');
const { getSqlite } = await import('@/lib/db');
const { runReplay } = await import('../scripts/judgment-replay.mjs');

const KEY = 'ts-replay-fixture-key-4e8a2c91d7';
const repoPath = mkdtempSync(join(os.tmpdir(), 'o8-judgment-replay-repo-'));
const outDir = mkdtempSync(join(os.tmpdir(), 'o8-judgment-replay-out-'));

let server: Server;
let endpoint = '';
const seenBodies: Array<Record<string, unknown>> = [];
const consoleLines: string[] = [];

const patch = (file: string, line: string) =>
  `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1,0 +1,1 @@\n+${line}`;

/** Per-file answers the fixture returns: [risk score 0..4, docsOnly probability]. */
const FIXTURE_ANSWERS: Record<string, [number, number]> = {
  'src/auth/session.ts': [3.5, 0.02],
  'src/api/route.ts': [3.0, 0.02],
  'src/lib/x.ts': [2.0, 0.02],
  'src/ui/a.tsx': [1.0, 0.02],
  'docs/readme.md': [0.2, 0.98],
};

function fixtureAnswers(state: { files: Array<{ path: string }> }) {
  const [score, docs] = FIXTURE_ANSWERS[state.files[0].path] ?? [2, 0.5];
  const noul = (value: number) => ({ type: 'noul', noul: value });
  return {
    model: 'jev-fixture',
    answers: {
      docsOnly: noul(docs),
      touchesMiddlewareOrAuth: noul(0.1),
      containsPlaceholderOrMockData: noul(0.05),
      addsTests: noul(0.2),
      scopeCreepBeyondTitle: noul(0.3),
      testsReachRealEntryPoint: noul(0.1),
      risk: {
        type: 'score',
        score,
        confidence: 0.9,
        probabilities: { 0: 0.1, 1: 0.2, 2: 0.4, 3: 0.2, 4: 0.1 },
      },
      recommendedAction: {
        type: 'choice',
        choice: 'operatorCard',
        confidence: 0.7,
        probabilities: { autoApprove: 0.1, operatorCard: 0.8, reject: 0.1 },
      },
    },
    usage: { input_tokens: 1000, output_tokens: 120 },
  };
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

interface ApprovalSeed {
  id: string;
  packetId: string;
  laneId: string;
  diff: unknown;
  status: 'approved' | 'rejected' | 'pending';
  actor?: 'desktop' | 'mobile' | 'system';
  createdAt: number;
  gatePassed?: boolean;
}

function insertApproval(seed: ApprovalSeed) {
  getSqlite().prepare(`
    INSERT INTO approvals (
      id, source, runtime, agent, session_key, title, description, summary, diff_json, gate_result_json,
      risk, packet_id, lane_id, status, created_at, updated_at, resolved_at, resolution_json, fingerprint
    ) VALUES (?, 'runtime', 'codex', 'worker', ?, 'Merge lane', 'desc', 'summary', ?, ?, 'low', ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    seed.id,
    `lane:${seed.laneId}`,
    JSON.stringify(seed.diff),
    seed.gatePassed === undefined ? null : JSON.stringify({ passed: seed.gatePassed, violations: [] }),
    seed.packetId,
    seed.laneId,
    seed.status,
    seed.createdAt,
    seed.createdAt,
    seed.actor ? seed.createdAt + 10 : null,
    seed.actor ? JSON.stringify({ action: seed.status, actor: seed.actor }) : null,
    `fp-${seed.id}`,
  );
}

function multiFile(file: string, line: string) {
  const text = patch(file, line);
  return { path: 'multi-file', after: text, files: [{ path: file, status: 'M', patch: text }] };
}

const tableCounts = () => Object.fromEntries(['approvals', 'lane_events', 'session_outcomes', 'lanes'].map((table) => [
  table,
  (getSqlite().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n,
]));

beforeAll(async () => {
  server = createServer(async (request, response) => {
    const body = JSON.parse(await readBody(request)) as Record<string, unknown>;
    seenBodies.push(body);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(fixtureAnswers(body.state as { files: Array<{ path: string }> })));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/systemone`;

  const base = Date.now() - 100_000;
  const lane = (packetId: string) => createLane({ repoPath, branch: `o8/${packetId}`, runtime: 'codex', packetId }).id;
  const laneA = lane('pkt-a');
  const laneB = lane('pkt-b');
  const laneC = lane('pkt-c');
  const laneD = lane('pkt-d');
  const laneE = lane('pkt-e');

  // Packet A: the same auth diff submitted twice. A post-rebase verification
  // failure lands between the two submissions, so only the first failed.
  insertApproval({ id: 'apr-a1', packetId: 'pkt-a', laneId: laneA, diff: multiFile('src/auth/session.ts', 'export const ttl = 0;'), status: 'approved', actor: 'desktop', createdAt: base + 1_000 });
  getSqlite().prepare(`INSERT INTO lane_events (id, lane_id, verb, actor, payload_json, timestamp) VALUES (?, ?, 'typecheck_auto_retry', 'system', '{}', ?)`)
    .run('evt-a-retry', laneA, new Date(base + 2_000).toISOString());
  insertApproval({ id: 'apr-a2', packetId: 'pkt-a', laneId: laneA, diff: multiFile('src/auth/session.ts', 'export const ttl = 0;'), status: 'approved', actor: 'desktop', createdAt: base + 3_000 });
  // Packet B: docs, approved, merged clean.
  insertApproval({ id: 'apr-b1', packetId: 'pkt-b', laneId: laneB, diff: multiFile('docs/readme.md', 'More docs.'), status: 'approved', actor: 'desktop', createdAt: base + 4_000 });
  // Packet C: rejected from the phone.
  insertApproval({ id: 'apr-c1', packetId: 'pkt-c', laneId: laneC, diff: multiFile('src/lib/x.ts', 'export const x = 1;'), status: 'rejected', actor: 'mobile', createdAt: base + 5_000 });
  // Packet D: the merge gate itself failed, then the operator rejected it.
  insertApproval({ id: 'apr-d1', packetId: 'pkt-d', laneId: laneD, diff: multiFile('src/api/route.ts', 'export const GET = 1;'), status: 'rejected', actor: 'desktop', createdAt: base + 6_000, gatePassed: false });
  // Packet E: UI change, approved, merged clean.
  insertApproval({ id: 'apr-e1', packetId: 'pkt-e', laneId: laneE, diff: multiFile('src/ui/a.tsx', 'export const A = 1;'), status: 'approved', actor: 'desktop', createdAt: base + 7_000 });
  // No diff text at all.
  insertApproval({ id: 'apr-empty', packetId: 'pkt-e', laneId: laneE, diff: { path: 'multi-file', files: [] }, status: 'pending', createdAt: base + 8_000 });

  const outcome = getSqlite().prepare(`
    INSERT INTO session_outcomes (id, repo_path, runtime, packet_id, outcome, summary, started_at, completed_at, merged_clean)
    VALUES (?, ?, 'codex', ?, 'succeeded', 'done', ?, ?, 1)
  `);
  const at = new Date(base + 9_000).toISOString();
  outcome.run('out-b', repoPath, 'pkt-b', at, at);
  outcome.run('out-e', repoPath, 'pkt-e', at, at);

  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      consoleLines.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
    });
  }
});

afterAll(async () => {
  vi.restoreAllMocks();
  delete process.env.O8_JUDGMENT_API_KEY;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(repoPath, { recursive: true, force: true });
  rmSync(outDir, { recursive: true, force: true });
});

beforeEach(() => {
  seenBodies.length = 0;
  process.env.O8_JUDGMENT_API_KEY = KEY;
});

async function capture(argv: string[]) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runReplay(argv, { stdout: (text) => stdout.push(text), stderr: (text) => stderr.push(text), endpoint, retryBaseMs: 1 });
  return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
}

describe('judgment replay against a fixture database and a local systemone fixture', () => {
  it('runs the command line: --dry-run prints a body with the setting off, and a live run refuses', () => {
    const env = { ...process.env, O8_JUDGMENT_API_KEY: KEY };
    const dry = spawnSync(process.execPath, ['scripts/judgment-replay.mjs', '--dry-run', '--limit', '1'], { env, encoding: 'utf8', timeout: 60_000 });
    expect(dry.status).toBe(0);
    const bodies = dry.stdout.split('\n').filter((line) => line.startsWith('{'));
    expect(bodies).toHaveLength(1);
    expect(JSON.parse(bodies[0])).toMatchObject({ model: 'jev-latest', questions: DIFF_QUESTIONS });

    const live = spawnSync(process.execPath, ['scripts/judgment-replay.mjs'], { env, encoding: 'utf8', timeout: 60_000 });
    expect(live.status).toBe(2);
    expect(live.stderr).toContain('judgment.provider is off');
    for (const text of [dry.stdout, dry.stderr, live.stdout, live.stderr]) expect(text).not.toContain(KEY);
  }, 120_000);

  it('refuses to run with judgment.provider off and sends nothing', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const result = await capture([]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('judgment.provider is off');
    expect(result.stdout).toBe('');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(seenBodies).toHaveLength(0);
    fetchSpy.mockRestore();
  });

  it('--dry-run prints one request body per distinct diff and sends nothing', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const before = tableCounts();
    const result = await capture(['--dry-run']);
    expect(result.code).toBe(0);
    const bodies = result.stdout.split('\n').filter((line) => line.startsWith('{')).map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(bodies).toHaveLength(5);
    for (const body of bodies) {
      expect(Object.keys(body).sort()).toEqual(['model', 'questions', 'state']);
      expect(body.model).toBe('jev-latest');
      expect(body.questions).toEqual(DIFF_QUESTIONS);
      expect(body.state).not.toHaveProperty('title');
    }
    expect(result.stdout).toContain('approvals=apr-a1,apr-a2 packets=pkt-a');
    expect(result.stdout).toContain('5 request bodies printed, nothing sent (7 approvals with diff_json, 5 distinct diffs)');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(seenBodies).toHaveLength(0);
    expect(tableCounts()).toEqual(before);
    expect(listJudgmentReceipts({ limit: 100 }).filter((receipt) => receipt.surface === 'calibration-replay')).toEqual([]);

    const limited = await capture(['--dry-run', '--limit', '2']);
    expect(limited.stdout.split('\n').filter((line) => line.startsWith('{'))).toHaveLength(2);
    fetchSpy.mockRestore();
  });

  it('asks each distinct diff once and prints the table with n, held-out thresholds, and spend', async () => {
    await updateOperatorDefaults({ judgmentProvider: 'typesafe' });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const before = tableCounts();
    const outPath = join(outDir, 'results.json');
    const result = await capture(['--out', outPath]);

    expect(result.code).toBe(0);
    expect(fetchSpy).toHaveBeenCalledTimes(5);
    expect(seenBodies).toHaveLength(5);
    const out = result.stdout;
    expect(out).toContain('approvals with diff_json: 7; without diff text: 1');
    expect(out).toContain('distinct diffs by sanitized-state hash: 5 (collapsed 1 duplicate approvals)');
    expect(out).toContain('distinct diffs whose approvals disagree on a label (counted positive): 1');
    expect(out).toContain('calls: 5 asked, 5 answered, 0 failed');

    // gateFailed: A (retry event) and D (gate result) positive; B and E negative; C unlabeled.
    expect(out).toContain('gateFailed by risk/4: n=4 distinct diffs (positives 2, negatives 2, abstained 0)');
    expect(out).toContain('AUC 1.000 (n=4)  Brier 0.036 (n=4)');
    // Held out by packet: D's positive is scored against A's threshold (0.875) and missed.
    // An in-sample fit would report 0 misses.
    expect(out).toContain('catch-every-positive threshold, leave-one-packet-out (4 of 4 packets scored): false alarms 0 of 2 negatives, missed 1 of 2 positives, 0 diffs had no positive outside their packet');
    expect(out).toMatch(/0\.8-0\.9\s+1\s+0\.88\s+1\.00/);
    expect(out).toMatch(/0\.0-0\.1\s+1\s+0\.05\s+0\.00/);

    // operatorRejected: every diff was resolved on desktop or mobile; C and D rejected.
    expect(out).toContain('operatorRejected by risk/4: n=5 distinct diffs (positives 2, negatives 3, abstained 0)');
    expect(out).toContain('operatorRejected by 1-docsOnly: n=5 distinct diffs');
    expect(out).toContain('mergedClean: no negatives, skipped (n=2 labeled distinct diffs)');

    expect(out).toContain('diff chars per input token:');
    expect(out).toContain('over 5000 input tokens, n=5 calls)');
    expect(out).toContain('spend: $0.000210 at $42 per billion input tokens (n=5 calls)');

    const receipts = listJudgmentReceipts({ limit: 100 }).filter((receipt) => receipt.surface === 'calibration-replay');
    expect(receipts).toHaveLength(5);
    expect(receipts.every((receipt) => receipt.ok && receipt.questions.risk.instructions === DIFF_QUESTIONS.risk.instructions)).toBe(true);
    expect(tableCounts()).toEqual(before);

    const saved = JSON.parse(readFileSync(outPath, 'utf8')) as { distinctDiffs: number; diffs: Array<{ approvalIds: string[]; receiptId: string | null }> };
    expect(saved.distinctDiffs).toBe(5);
    expect(saved.diffs.find((diff) => diff.approvalIds.length === 2)?.approvalIds).toEqual(['apr-a1', 'apr-a2']);
    expect(saved.diffs.every((diff) => typeof diff.receiptId === 'string')).toBe(true);

    for (const text of [out, result.stderr, readFileSync(outPath, 'utf8'), ...consoleLines]) expect(text).not.toContain(KEY);
    fetchSpy.mockRestore();
  });

  it('refuses a live run with the setting on but no key', async () => {
    delete process.env.O8_JUDGMENT_API_KEY;
    const result = await capture([]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('no judgment key is configured');
    expect(seenBodies).toHaveLength(0);
  });
});
