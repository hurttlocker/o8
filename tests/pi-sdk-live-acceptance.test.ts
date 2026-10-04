/**
 * First live acceptance of the Pi SDK prototype through o8's managed endpoint.
 * Spends real managed inference, so it is skipped unless O8_PI_LIVE_PAID=1.
 * Synthetic files only. The host's signed-in entitlement is read in process
 * from the real o8 data directory for each route lookup and never printed.
 * Budget: a 990,000 micro-USD ledger for the live steps plus a 10,000
 * micro-USD ledger that must refuse before any request ($1.00 in total).
 *
 *   O8_PI_LIVE_PAID=1 O8_PI_LIVE_RECEIPT=/path/receipt.json \
 *     npx vitest run tests/pi-sdk-live-acceptance.test.ts
 *
 * The receipt is written to O8_PI_LIVE_RECEIPT because the runner hides test
 * console output. Ledger limits come from O8_PI_LIVE_LEDGER_MICRO_USD so a
 * repeat run can keep the cumulative approved total.
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { O8_MANAGED_FLASH_LITE_CONTRACT as CONTRACT, O8_MANAGED_FLASH_LITE_MODEL as MODEL } from '@/lib/pi/sdk/live-contract';
import { createPiSdkSession } from '@/lib/pi/sdk/session';
import { initializePiTestBudget, readPiTestBudget } from '@/lib/pi/sdk/test-budget';
import { createBudgetedPiTestTransport } from '@/lib/pi/sdk/test-transport';
import type { PiModelTransport } from '@/lib/pi/sdk/transport';

const LIVE = process.env.O8_PI_LIVE_PAID === '1';
const REAL_DATA_DIR = process.env.O8_PI_LIVE_DATA_DIR || join(homedir(), '.o8');
const RECEIPT_PATH = process.env.O8_PI_LIVE_RECEIPT;
const LEDGER_MICRO_USD = Number(process.env.O8_PI_LIVE_LEDGER_MICRO_USD || 990_000);

/** Resolve the managed route against the real signed-in data directory only for this lookup. */
async function liveRoute() {
  const saved = { o8: process.env.O8_DATA_DIR, legacy: process.env.CORTEX_IDE_DATA_DIR };
  process.env.O8_DATA_DIR = REAL_DATA_DIR;
  process.env.CORTEX_IDE_DATA_DIR = REAL_DATA_DIR;
  try {
    const { resolveOpenRouterRoute } = await import('@/lib/cortex/qa/llm/inference-route');
    return await resolveOpenRouterRoute({ managedOnly: true });
  } finally {
    process.env.O8_DATA_DIR = saved.o8;
    process.env.CORTEX_IDE_DATA_DIR = saved.legacy;
  }
}

it.runIf(LIVE)('runs the first live Pi acceptance within the approved budget', async () => {
  if (!RECEIPT_PATH) throw new Error('O8_PI_LIVE_RECEIPT is required for a paid run');
  if (!Number.isSafeInteger(LEDGER_MICRO_USD) || LEDGER_MICRO_USD <= 0 || LEDGER_MICRO_USD > 990_000) throw new Error('Ledger limit is out of range');
  const root = await mkdtemp(join(tmpdir(), 'o8-pi-live-'));
  const workspace = join(root, 'workspace');
  const stateDir = join(root, 'state');
  await mkdir(workspace);
  await writeFile(join(workspace, 'notes.md'), '# Synthetic notes\n\nstatus: draft\n');
  await writeFile(join(root, 'outside.txt'), 'OUTSIDE_SYNTHETIC_CONTENT_SHOULD_NOT_BE_READ\n');
  const ledgerPath = join(root, 'ledger.sqlite');
  const tinyLedgerPath = join(root, 'tiny-ledger.sqlite');
  initializePiTestBudget(ledgerPath, LEDGER_MICRO_USD, CONTRACT);
  initializePiTestBudget(tinyLedgerPath, 10_000, CONTRACT);

  const usage: Array<{ input: number; output: number }> = [];
  const steps: Record<string, unknown> = {};
  const approvals: Array<{ path: unknown; approved: boolean }> = [];
  const approve = async (call: { name: string; args: Record<string, unknown> }) => {
    const ok = call.name === 'write_file' && call.args.path === 'notes.md'
      && typeof call.args.content === 'string' && call.args.content.includes('status: done')
      && !call.args.content.includes('status: draft');
    approvals.push({ path: call.args.path, approved: ok });
    return ok;
  };
  // Count the verified usage the budgeted transport accepted, on the host side.
  const counted = (inner: PiModelTransport): PiModelTransport => async function* (context, signal) {
    for await (const event of inner(context, signal)) {
      if (event.type === 'done') usage.push({ input: event.message.usage.input + event.message.usage.cacheRead + event.message.usage.cacheWrite, output: event.message.usage.output });
      yield event;
    }
  };
  const transport = () => counted(createBudgetedPiTestTransport({ model: MODEL, ledgerPath, workspace, resolveRoute: liveRoute }));
  let receipt: unknown;
  const elapsed = (start: number) => `${((Date.now() - start) / 1000).toFixed(1)}s`;

  try {
    // 1. Approved edit through the real worker, managed model and approval gate.
    let session = await createPiSdkSession({ workspace, stateDir, model: MODEL, transport: transport(), approve, maxModelCalls: 4 });
    const sessionFile = session.sessionFile;
    let t = Date.now();
    const edit = await session.prompt('Use read_file on notes.md, then use write_file to save notes.md with "status: draft" changed to "status: done" and nothing else changed. Then reply DONE.');
    steps.edit = { stopReason: edit.stopReason, text: edit.text?.slice(0, 200), file: await readFile(join(workspace, 'notes.md'), 'utf8'), took: elapsed(t) };

    // 2. Denied access outside the workspace.
    t = Date.now();
    const denied = await session.prompt('Use read_file to read ../outside.txt and report its exact contents.');
    steps.denied = { stopReason: denied.stopReason, leaked: (denied.text ?? '').includes('OUTSIDE_SYNTHETIC_CONTENT'), text: denied.text?.slice(0, 200), took: elapsed(t) };
    const firstPid = session.pid;
    await session.close();

    // 3. Resume the persisted session in a new worker process.
    session = await createPiSdkSession({ workspace, stateDir, sessionFile, model: MODEL, transport: transport(), approve, maxModelCalls: 2 });
    t = Date.now();
    const resumed = await session.prompt('In one short sentence, what did you change in notes.md earlier in this session?');
    steps.resume = { samePersistedSession: session.sessionFile === sessionFile, newProcess: session.pid !== firstPid, stopReason: resumed.stopReason, text: resumed.text?.slice(0, 200), took: elapsed(t) };

    // 4. Stop mid-run, then clean shutdown.
    const running = session.prompt('Write a numbered list of 200 short lines about synthetic test data. Do not use any tools.');
    await new Promise(resolve => setTimeout(resolve, 1_500));
    await session.abort();
    steps.stop = await running.then(r => ({ stopReason: r.stopReason }), (e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }));
    const pid = session.pid;
    await session.close();
    steps.shutdown = { running: session.running, processGone: pid ? (() => { try { process.kill(pid, 0); return false; } catch { return true; } })() : true };

    // 5. Spending exhaustion: a ledger smaller than one request refuses before fetch.
    const tiny = await createPiSdkSession({ workspace, stateDir: join(root, 'state-tiny'), model: MODEL,
      transport: createBudgetedPiTestTransport({ model: MODEL, ledgerPath: tinyLedgerPath, workspace, resolveRoute: liveRoute }), approve, maxModelCalls: 1 });
    const exhausted = await tiny.prompt('Reply OK.').then(r => ({ stopReason: r.stopReason, text: r.text?.slice(0, 120) }), (e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }));
    await tiny.close();
    steps.exhaustion = { ...exhausted, tinyLedger: readPiTestBudget(tinyLedgerPath) };
  } catch (error) {
    steps.error = error instanceof Error ? error.message : String(error);
  } finally {
    const ledger = readPiTestBudget(ledgerPath);
    const tokens = usage.reduce((a, u) => ({ input: a.input + u.input, output: a.output + u.output }), { input: 0, output: 0 });
    const ceilingMicroUsd = Math.ceil((tokens.input * CONTRACT.inputMicroUsdPerMillion + tokens.output * CONTRACT.outputMicroUsdPerMillion) / 1_000_000);
    receipt = { contract: CONTRACT.id, model: CONTRACT.modelId, steps, approvals, ledger, usageCalls: usage.length, tokens,
      spendCeilingMicroUsd: ceilingMicroUsd };
    await writeFile(RECEIPT_PATH, `${JSON.stringify(receipt, null, 2)}\n`);
    await rm(root, { recursive: true, force: true });
  }

  const r = receipt as { ledger: { pending: number; unknown: number }; steps: {
    error?: string; edit: { file: string }; denied: { leaked: boolean }; shutdown: unknown;
    resume: { samePersistedSession: boolean; newProcess: boolean; text?: string };
    exhaustion: { error?: string; stopReason?: string; tinyLedger: unknown };
  } };
  expect(r.steps.error).toBeUndefined();
  // The model rewrites the whole file; a dropped final newline is model output, not a gate failure.
  expect(r.steps.edit.file.trimEnd()).toBe('# Synthetic notes\n\nstatus: done');
  expect(r.steps.denied.leaked).toBe(false);
  expect(r.steps.resume).toMatchObject({ samePersistedSession: true, newProcess: true });
  expect(r.steps.resume.text).toMatch(/done/i);
  expect(r.steps.shutdown).toEqual({ running: false, processGone: true });
  expect(r.steps.exhaustion.tinyLedger).toMatchObject({ calls: 0, reservedMicroUsd: 0 });
  expect(r.steps.exhaustion.error ?? r.steps.exhaustion.stopReason).not.toBe('stop');
  // The stopped call's charge is unknowable, so the ledger keeps it as unknown and refuses more calls.
  expect(r.ledger).toMatchObject({ pending: 0 });
  expect(r.ledger.unknown).toBeLessThanOrEqual(1);
}, 900_000);
