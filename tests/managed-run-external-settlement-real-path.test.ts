import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

const directory = mkdtempSync(join(tmpdir(), 'o8-external-settlement-'));
process.env.CORTEX_IDE_DATA_DIR = directory;
process.env.O8_DATA_DIR = directory;
const route = await import('@/app/api/panel/managed-runs/route');
const { getOrCreateWsToken } = await import('@/lib/ws-auth');
const { closeDb } = await import('@/lib/db');
const { mintPacketWorkerToken } = await import('@/lib/auth/packet-worker-token');
const { writeOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const binding = {
  schema: 'o8/managed-run-settlement-binding/v1',
  executionKey: 'fixture-execution',
  generation: 1,
  branch: 'fixture/settlement',
  providerSessionId: '00000000-0000-4000-8000-000000000001',
  profileDigest: 'a'.repeat(64),
  receiptId: 'fixture-receipt',
};
function request(body: unknown, token = getOrCreateWsToken()) {
  return new Request('http://localhost/api/panel/managed-runs', {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
function registration(id: string) {
  return { action: 'register', id, session: `cortex-run-${id}`, command: 'fixture coordinator',
    cwd: directory, mode: 'detach', settlementBinding: { ...binding, executionKey: id } };
}
function persisted(id: string) {
  return JSON.parse(readFileSync(join(directory, 'managed-runs.json'), 'utf8')).runs
    .find((run: { id: string }) => run.id === id);
}
afterAll(() => { closeDb(); rmSync(directory, { recursive: true, force: true }); });

describe('operator external settlement through managed-runs API and persisted state', () => {
  it('advertises the settlement contract without creating a reservation', async () => {
    const response = await route.GET(new Request('http://localhost/api/panel/managed-runs', {
      headers: { authorization: `Bearer ${getOrCreateWsToken()}` },
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ schema: 'o8/managed-runs/v1',
      settlementContract: 'o8/managed-run-settlement/v1', runs: [] });
    expect(existsSync(join(directory, 'managed-runs.json'))).toBe(false);
  });

  it('replays a lost registration response without erasing state, and rejects a conflicting binding', async () => {
    const body = registration('replaySettlement');
    expect((await route.POST(request(body))).status).toBe(200);
    const first = persisted(body.id);
    expect(first.settlement?.binding).toEqual(body.settlementBinding);
    expect((await route.POST(request(body))).status).toBe(200);
    expect(persisted(body.id)).toEqual(first);
    const conflict = await route.POST(request({ ...body, settlementBinding: { ...body.settlementBinding, generation: 2 } }));
    expect(conflict.status).toBe(409);
    expect(persisted(body.id)).toEqual(first);
    expect((await route.POST(request({ ...body, id: 'duplicateExecution', session: 'cortex-run-duplicateExecution' }))).status).toBe(409);
  });

  it('retains unknown external work when the wrapper finishes, then accepts only a matching sealed receipt', async () => {
    const body = registration('unknownSettlement');
    const registered = await (await route.POST(request(body))).json();
    const finish = await route.POST(request({ action: 'finish', id: body.id, exitCode: 0 }));
    expect(finish.status).toBe(409);
    expect(persisted(body.id)).toMatchObject({ status: 'settling', finishedAt: null, exitCode: 0 });
    const receipt = { action: 'settlement', id: body.id, bindingDigest: registered.run.settlement.bindingDigest,
      receiptId: binding.receiptId, sequence: 1, state: 'quiet', providerSessionId: binding.providerSessionId };
    expect((await route.POST(request({ ...receipt, receiptId: 'wrong' }))).status).toBe(409);
    expect((await route.POST(request(receipt))).status).toBe(200);
    expect(persisted(body.id)).toMatchObject({ status: 'finished', exitCode: 0,
      settlement: { receipt: { state: 'quiet', sequence: 1 } } });
    expect((await route.POST(request(receipt))).status).toBe(200);
    expect((await route.POST(request({ ...receipt, state: 'active', sequence: 2 }))).status).toBe(409);
    expect((await route.POST(request({ action: 'kill', session: body.session }))).status).toBe(200);
    expect(persisted(body.id)).toMatchObject({ status: 'finished', settlement: { stopRequestId: null } });
  });

  it('binds a reserved provider UUID once and distinguishes never-launched cancellation', async () => {
    const body = registration('reservedSettlement');
    body.settlementBinding.providerSessionId = null as unknown as string;
    const registered = await (await route.POST(request(body))).json();
    const base = { id: body.id, bindingDigest: registered.run.settlement.bindingDigest };
    const receipt = { ...base, action: 'settlement', receiptId: binding.receiptId, sequence: 1, state: 'quiet', providerSessionId: null };
    expect((await route.POST(request(receipt))).status).toBe(409);
    const bind = { ...base, action: 'bind-session', providerSessionId: binding.providerSessionId };
    expect((await route.POST(request(bind))).status).toBe(200);
    expect((await route.POST(request(bind))).status).toBe(200);
    expect((await route.POST(request({ ...bind, providerSessionId: '00000000-0000-4000-8000-000000000002' }))).status).toBe(409);
    expect(persisted(body.id).settlement.providerSessionId).toBe(binding.providerSessionId);
    const cancelled = registration('cancelledSettlement');
    cancelled.settlementBinding.providerSessionId = null as unknown as string;
    const reserved = await (await route.POST(request(cancelled))).json();
    expect((await route.POST(request({ ...receipt, id: cancelled.id, bindingDigest: reserved.run.settlement.bindingDigest,
      cancelledBeforeLaunch: true }))).status).toBe(200);
    expect((await route.POST(request({ ...bind, id: cancelled.id, bindingDigest: reserved.run.settlement.bindingDigest }))).status).toBe(409);
  });

  it('keeps stop pending while external validation runs and requires the exact stop acknowledgement', async () => {
    const body = registration('stoppingSettlement');
    const registered = await (await route.POST(request(body))).json();
    expect((await route.POST(request({ action: 'settlement', id: body.id,
      bindingDigest: registered.run.settlement.bindingDigest, receiptId: binding.receiptId,
      providerSessionId: binding.providerSessionId, sequence: 1, state: 'active' }))).status).toBe(200);
    const pending = route.POST(request({ action: 'kill', session: body.session }));
    for (let index = 0; index < 100 && !persisted(body.id).settlement.stopRequestId; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const stopRequestId = persisted(body.id).settlement.stopRequestId;
    expect(stopRequestId).toBeTruthy();
    expect(persisted(body.id).status).toBe('settling');
    const receipt = { action: 'settlement', id: body.id, bindingDigest: registered.run.settlement.bindingDigest,
      receiptId: binding.receiptId, sequence: 2, state: 'quiet', providerSessionId: binding.providerSessionId };
    expect((await route.POST(request(receipt))).status).toBe(409);
    expect((await route.POST(request({ ...receipt, stopRequestId }))).status).toBe(200);
    expect((await pending).status).toBe(200);
    expect(persisted(body.id)).toMatchObject({ status: 'killed', termination: { confirmedDead: true, externalSettlement: 'quiet' } });
  }, 15_000);

  it('does not let the worker write or read the host receipt, and reloads pending state after module restart', async () => {
    const body = registration('workerSettlement');
    const packetId = 'settlement-packet';
    writeOrchestratorControlPlaneState({ ...createEmptyOrchestratorMissionState(), missionId: 'settlement-mission', repoPath: directory,
      packets: [{ id: packetId, referenceLabel: 'PKT-SETTLEMENT', title: 'settlement', summary: 'settlement', status: 'running',
        queueState: 'queued', releaseState: 'pending', runtime: 'codex', dependencyPacketIds: [], dependencyLabels: [],
        blockedReason: null, lane: null, review: null, workspaceTargetPath: directory, branchTarget: binding.branch }] });
    const token = mintPacketWorkerToken(packetId);
    expect((await route.POST(request({ ...body, packetId }, token))).status).toBe(403);
    expect((await route.POST(request({ ...body, packetId }))).status).toBe(200);
    expect((await route.POST(request({ action: 'settlement', id: body.id }, token))).status).toBe(403);
    const workerRuns = await (await route.GET(new Request('http://localhost/api/panel/managed-runs', {
      headers: { authorization: `Bearer ${token}` },
    }))).json();
    const visible = workerRuns.runs.find((run: { id: string }) => run.id === body.id);
    expect(visible.settlement).toBeUndefined();
    expect(visible.settlementState).toBe('unknown');
    closeDb();
    const globalStore = globalThis as typeof globalThis & { __o8ManagedRuns?: unknown; __o8ManagedRunsHydrated?: boolean };
    delete globalStore.__o8ManagedRuns;
    delete globalStore.__o8ManagedRunsHydrated;
    vi.resetModules();
    const restarted = await import('@/app/api/panel/managed-runs/route');
    const response = await restarted.POST(request({ action: 'finish', id: body.id, exitCode: 0 }));
    expect(response.status).toBe(409);
    expect(persisted(body.id)).toMatchObject({ status: 'settling', settlement: { receipt: null } });
    (await import('@/lib/db')).closeDb();
  });

  it('returns a durable pending stop when no external receipt arrives', async () => {
    const body = registration('missingReceiptStop');
    expect((await route.POST(request(body))).status).toBe(200);
    const response = await route.POST(request({ action: 'kill', session: body.session }));
    expect(response.status).toBe(409);
    expect(persisted(body.id)).toMatchObject({ status: 'settling', finishedAt: null,
      termination: { confirmedDead: false, externalSettlement: 'unknown' } });
  }, 15_000);

  it('fails closed when the durable settlement store is locked', async () => {
    const body = registration('contestedReceipt');
    const registered = await (await route.POST(request(body))).json();
    const previous = persisted(body.id);
    const lock = join(directory, 'managed-runs.json.lock');
    mkdirSync(lock);
    try {
      const response = await route.POST(request({ action: 'settlement', id: body.id,
        bindingDigest: registered.run.settlement.bindingDigest, receiptId: binding.receiptId,
        providerSessionId: binding.providerSessionId, sequence: 1, state: 'quiet' }));
      expect(response.status).toBe(503);
      expect(persisted(body.id)).toEqual(previous);
    } finally { rmdirSync(lock); }
  });
});
