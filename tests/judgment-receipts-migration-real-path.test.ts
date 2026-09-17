/**
 * #2459 — the judgment receipts table through the real boot migration.
 *
 * Real-path doctrine: each case owns a disposable data dir, the schema is
 * reached only by opening the product database through `getDb()` (which runs
 * the same boot migration a shipped app runs), and every receipt is written
 * with `recordJudgmentReceipt` and read back with `listJudgmentReceipts`. The
 * old-shape case reproduces the operator install that already holds an
 * earlier `judgment_receipts` (no `hidden_text`, no v63 marker), where every
 * write failed. `askJudgment` runs against a local endpoint fixture, and the
 * calibration replay runs as a child process against a copy of that database.
 */
import { spawn } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { startJudgmentEndpointFixture, JUDGMENT_FIXTURE_KEY, type FixtureReply, type SeenRequest } from './fixtures/judgment-endpoint';

/** The shape an intermediate build of #2434 left behind: everything but `hidden_text`. */
const OLD_SHAPE_SQL = `
  DROP TABLE IF EXISTS judgment_receipts;
  CREATE TABLE judgment_receipts (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    model TEXT,
    ok INTEGER NOT NULL,
    questions_json TEXT NOT NULL,
    answers_json TEXT,
    input_tokens INTEGER,
    output_tokens INTEGER,
    latency_ms INTEGER NOT NULL,
    attempts INTEGER NOT NULL,
    truncated INTEGER NOT NULL DEFAULT 0,
    error_json TEXT,
    packet_id TEXT,
    lane_id TEXT,
    approval_id TEXT,
    surface TEXT,
    created_at TEXT NOT NULL
  );
`;

const CURRENT_COLUMNS = [
  'id', 'provider', 'model', 'ok', 'questions_json', 'answers_json', 'input_tokens', 'output_tokens',
  'latency_ms', 'attempts', 'truncated', 'hidden_text', 'error_json', 'packet_id', 'lane_id', 'approval_id',
  'surface', 'created_at',
];

const QUESTIONS = {
  docsOnly: { type: 'noul' as const, instructions: 'The diff only changes documentation.' },
};

const scratch: string[] = [];
const consoleLines: string[] = [];
let fixtureEndpoint = '';
let fixtureReplies: FixtureReply[] = [];
let fixtureSeen: SeenRequest[] = [];
let closeFixture: () => Promise<void>;

function disposableDataDir(label: string): string {
  const dir = mkdtempSync(join(os.tmpdir(), `o8-judgment-migration-${label}-`));
  scratch.push(dir);
  return dir;
}

const dbPathOf = (dataDir: string) => join(dataDir, 'cortex-ide.db');

function columnRows(dataDir: string): Array<Record<string, unknown>> {
  const sqlite = new Database(dbPathOf(dataDir), { readonly: true });
  try {
    return sqlite.prepare('PRAGMA table_info(judgment_receipts)').all() as Array<Record<string, unknown>>;
  } finally {
    sqlite.close();
  }
}

const columnNames = (dataDir: string) => columnRows(dataDir).map((row) => row.name as string);

/**
 * Point the process at `dataDir` and open the product database there through
 * its real entry point, so the boot migration runs exactly as it does in the
 * app. Returns freshly-evaluated module instances bound to that data dir.
 */
async function bootAt(dataDir: string) {
  process.env.CORTEX_IDE_DATA_DIR = dataDir;
  vi.resetModules();
  const db = await import('@/lib/db');
  db.getSqlite();
  const receipts = await import('@/lib/judgment/receipts');
  return { db, receipts };
}

/** A booted database whose `judgment_receipts` was then rolled back to the old shape. */
function seedOldShapeDataDir(label: string): Promise<string> {
  const dataDir = disposableDataDir(label);
  return bootAt(dataDir).then(({ db }) => {
    db.closeDb();
    const sqlite = new Database(dbPathOf(dataDir));
    try {
      sqlite.exec(OLD_SHAPE_SQL);
    } finally {
      sqlite.close();
    }
    return dataDir;
  });
}

const receiptInput = (packetId: string) => ({
  provider: 'typesafe' as const,
  model: 'jev-fixture',
  ok: true,
  questions: QUESTIONS,
  answers: { docsOnly: { noul: 0.97 } },
  inputTokens: 120,
  outputTokens: 12,
  latencyMs: 42,
  attempts: 1,
  truncated: false,
  hiddenText: true,
  error: null,
  packetId,
  laneId: null,
  approvalId: `apr-${packetId}`,
  surface: 'approval-card',
});

/** Write and read one receipt through the real writer and reader. */
async function writeAndReadBack(dataDir: string, packetId: string) {
  const { receipts } = await bootAt(dataDir);
  const id = receipts.recordJudgmentReceipt(receiptInput(packetId));
  expect(id).not.toBeNull();
  const [stored] = receipts.listJudgmentReceipts({ packetId });
  expect(stored).toBeDefined();
  expect(stored.id).toBe(id);
  expect(stored.hiddenText).toBe(true);
  expect(stored.truncated).toBe(false);
  expect(stored.questions).toEqual(QUESTIONS);
  return stored;
}

const receiptWriteWarnings = () => consoleLines.filter((line) => line.includes('receipt write failed'));

/**
 * Run an ES module in a child process against `dataDir`. The child must not
 * block this process: the endpoint fixture answers from this event loop.
 */
function runChild(source: string, dataDir: string): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const child = spawn(
    process.execPath,
    ['--conditions=react-server', '--import', 'tsx', '--input-type=module', '-e', source],
    {
      env: {
        ...process.env,
        CORTEX_IDE_DATA_DIR: dataDir,
        O8_JUDGMENT_API_KEY: JUDGMENT_FIXTURE_KEY,
        TSX_TSCONFIG_PATH: join(process.cwd(), 'tsconfig.json'),
      },
    },
  );
  const stdout: string[] = [];
  const stderr: string[] = [];
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk.toString('utf8')));
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk.toString('utf8')));
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout: stdout.join(''), stderr: stderr.join('') }));
  });
}

beforeAll(async () => {
  const fixture = await startJudgmentEndpointFixture();
  ({ endpoint: fixtureEndpoint, replies: fixtureReplies, seen: fixtureSeen } = fixture);
  closeFixture = fixture.close;
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      consoleLines.push(args.map((arg) => (arg instanceof Error ? arg.message : typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
    });
  }
});

afterAll(async () => {
  vi.restoreAllMocks();
  await closeFixture();
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

describe('judgment receipts boot migration across database shapes', () => {
  it('reconciles a pre-existing table that predates hidden_text', async () => {
    const dataDir = await seedOldShapeDataDir('old');
    // The field database carries no v63 marker; the reconcile must not depend on one.
    expect(existsSync(join(dataDir, '.db-migrated-v63'))).toBe(false);
    expect(columnNames(dataDir)).not.toContain('hidden_text');

    await bootAt(dataDir);

    expect([...columnNames(dataDir)].sort()).toEqual([...CURRENT_COLUMNS].sort());
    const hiddenText = columnRows(dataDir).find((row) => row.name === 'hidden_text');
    expect(hiddenText).toMatchObject({ type: 'INTEGER', notnull: 1, dflt_value: '0' });
    await writeAndReadBack(dataDir, 'pkt-old-shape');
    expect(receiptWriteWarnings()).toEqual([]);
  });

  it('leaves a database already at the current shape untouched', async () => {
    const dataDir = disposableDataDir('current');
    const { db } = await bootAt(dataDir);
    const before = columnRows(dataDir);
    expect(before.map((row) => row.name)).toEqual(CURRENT_COLUMNS);
    db.closeDb();

    await bootAt(dataDir);

    expect(columnRows(dataDir)).toEqual(before);
    await writeAndReadBack(dataDir, 'pkt-current-shape');
    expect(receiptWriteWarnings()).toEqual([]);
  });

  it('creates the full shape on a fresh database', async () => {
    const dataDir = disposableDataDir('fresh');
    await bootAt(dataDir);

    expect(columnNames(dataDir)).toEqual(CURRENT_COLUMNS);
    await writeAndReadBack(dataDir, 'pkt-fresh');
    expect(receiptWriteWarnings()).toEqual([]);
  });

  it('records a receipt for askJudgment against the endpoint fixture on an old-shape database', async () => {
    const dataDir = await seedOldShapeDataDir('ask');
    const { receipts } = await bootAt(dataDir);
    const { updateOperatorDefaults } = await import('@/lib/operator/defaults');
    const { askJudgment } = await import('@/lib/judgment/client');
    const { judgmentKeyPath } = await import('@/lib/judgment/key');
    await updateOperatorDefaults({ judgmentProvider: 'typesafe' });
    writeFileSync(judgmentKeyPath(), `${JUDGMENT_FIXTURE_KEY}\n`);
    chmodSync(judgmentKeyPath(), 0o600);

    fixtureReplies.length = 0;
    fixtureSeen.length = 0;
    fixtureReplies.push({
      status: 200,
      body: { model: 'jev-fixture', answers: { docsOnly: { type: 'noul', noul: 0.94 } }, usage: { input_tokens: 800, output_tokens: 30 } },
    });
    const result = await askJudgment(
      {
        state: { files: [{ path: 'docs/readme.md' }], diff: 'diff --git a/docs/readme.md b/docs/readme.md' },
        questions: QUESTIONS,
        context: { packetId: 'pkt-ask', approvalId: 'apr-ask', surface: 'approval-card', hiddenText: true },
      },
      { endpoint: fixtureEndpoint, retryBaseMs: 1 },
    );

    expect(fixtureSeen).toHaveLength(1);
    expect(result).not.toBeNull();
    const [receipt] = receipts.listJudgmentReceipts({ packetId: 'pkt-ask' });
    expect(receipt.id).toBe(result!.receiptId);
    expect(receipt.ok).toBe(true);
    expect(receipt.hiddenText).toBe(true);
    expect(receiptWriteWarnings()).toEqual([]);
  });

  it('writes one receipt when the calibration replay runs against a copy of an old-shape database', async () => {
    const dataDir = disposableDataDir('replay');
    const { db } = await bootAt(dataDir);
    const { createLane } = await import('@/lib/lane/registry');
    const repoPath = disposableDataDir('replay-repo');
    const laneId = createLane({ repoPath, branch: 'o8/pkt-replay', runtime: 'codex', packetId: 'pkt-replay' }).id;
    const patch = 'diff --git a/docs/readme.md b/docs/readme.md\n--- a/docs/readme.md\n+++ b/docs/readme.md\n@@ -1,0 +1,1 @@\n+More docs.';
    db.getSqlite().prepare(`
      INSERT INTO approvals (
        id, source, runtime, agent, session_key, title, description, summary, diff_json, gate_result_json,
        risk, packet_id, lane_id, status, created_at, updated_at, resolved_at, resolution_json, fingerprint
      ) VALUES (?, 'runtime', 'codex', 'worker', ?, 'Merge lane', 'desc', 'summary', ?, NULL, 'low', ?, ?, 'approved', ?, ?, ?, ?, ?)
    `).run(
      'apr-replay', `lane:${laneId}`,
      JSON.stringify({ path: 'multi-file', after: patch, files: [{ path: 'docs/readme.md', status: 'M', patch }] }),
      'pkt-replay', laneId, Date.now() - 1_000, Date.now() - 1_000, Date.now(),
      JSON.stringify({ action: 'approved', actor: 'desktop' }), 'fp-apr-replay',
    );
    const { updateOperatorDefaults } = await import('@/lib/operator/defaults');
    await updateOperatorDefaults({ judgmentProvider: 'typesafe' });
    db.closeDb();
    // Roll the receipts table back to the shape the operator install carries,
    // with the seeded history already in place.
    const seeded = new Database(dbPathOf(dataDir));
    try {
      seeded.exec(OLD_SHAPE_SQL);
    } finally {
      seeded.close();
    }

    // The replay reads its own copy, exactly as it did against the operator's database.
    const copyDir = disposableDataDir('replay-copy');
    cpSync(dataDir, copyDir, { recursive: true });
    expect(columnNames(copyDir)).not.toContain('hidden_text');

    fixtureReplies.length = 0;
    fixtureSeen.length = 0;
    fixtureReplies.push({
      status: 200,
      body: {
        model: 'jev-fixture',
        answers: {
          docsOnly: { type: 'noul', noul: 0.98 },
          touchesMiddlewareOrAuth: { type: 'noul', noul: 0.01 },
          containsPlaceholderOrMockData: { type: 'noul', noul: 0.01 },
          addsTests: { type: 'noul', noul: 0.1 },
          scopeCreepBeyondTitle: { type: 'noul', noul: 0.1 },
          testsReachRealEntryPoint: { type: 'noul', noul: 0.1 },
          risk: { type: 'score', score: 0.4, confidence: 0.9, probabilities: { 0: 0.6, 1: 0.2, 2: 0.1, 3: 0.05, 4: 0.05 } },
          recommendedAction: { type: 'choice', choice: 'autoApprove', confidence: 0.8, probabilities: { autoApprove: 0.8, operatorCard: 0.15, reject: 0.05 } },
        },
        usage: { input_tokens: 900, output_tokens: 40 },
      },
    });

    // The command line has no endpoint flag, so the child imports the script's
    // own entry point and passes the fixture the way the replay tests do.
    const replayUrl = pathToFileURL(join(process.cwd(), 'scripts/judgment-replay.mjs')).href;
    const child = await runChild(`
      const { runReplay } = await import(${JSON.stringify(replayUrl)});
      process.exitCode = await runReplay(['--limit', '1'], { retryBaseMs: 1, endpoint: ${JSON.stringify(fixtureEndpoint)} });
    `, copyDir);

    const output = `${child.stdout}\n${child.stderr}`;
    expect(output).not.toContain('receipt write failed');
    expect(output).not.toContain('no column named hidden_text');
    expect(output).toContain('calls: 1 asked, 1 answered, 0 failed');
    expect(child.status).toBe(0);
    expect(fixtureSeen).toHaveLength(1);

    const { receipts } = await bootAt(copyDir);
    const written = receipts.listJudgmentReceipts({ limit: 10 }).filter((row) => row.surface === 'calibration-replay');
    expect(written).toHaveLength(1);
    expect(written[0].ok).toBe(true);
    expect(written[0].approvalId).toBe('apr-replay');
    expect(receiptWriteWarnings()).toEqual([]);
  }, 180_000);
});
