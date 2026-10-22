import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ perform: vi.fn(), sources: vi.fn(), tail: vi.fn() }));
vi.mock('@/lib/runtime/actions', () => ({ performRuntimeAction: h.perform }));
vi.mock('@/lib/codex/owned', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/codex/owned')>(),
  getOwnedCodexTelemetrySources: h.sources,
  getOwnedCodexRuntimeTail: h.tail,
}));
vi.mock('@/lib/orchestrator/headless-loop', () => ({
  runHeadlessSprintTick: vi.fn(async () => ({ launched: 0, active: 0 })),
}));
vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: vi.fn(async () => {}) }));
vi.mock('@/lib/command-center/snapshot', () => ({ invalidateCommandCenterSnapshotCaches: vi.fn() }));
vi.mock('@/lib/mobile/inbox', () => ({ invalidateInboxCache: vi.fn() }));
vi.mock('@/lib/runtime/inventory', () => ({ getRuntimeInventorySnapshot: vi.fn(async () => ({ agents: [] })) }));

const dataDir = mkdtempSync(join(tmpdir(), 'o8-steer-queue-'));
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_DATA_DIR = dataDir;
const { closeDb } = await import('@/lib/db');
const { createLane, getLaneEvents, setLaneStatus, updateLane } = await import('@/lib/lane/registry');
const { getOrCreateWsToken } = await import('@/lib/ws-auth');
const { advanceCorrectionStop } = await import('@/lib/db/worker-correction-fences');
const { recordLaneEvent } = await import('@/lib/lane/events');
const { probeMetadataLockProcessIdentitySync } = await import('@/lib/worktree/metadata-lock-process-identity');
const processIdentity = await import('@/lib/worktree/metadata-lock-process-identity');
const { readSessionSteerTranscriptEvents } = await import('@/lib/orchestrator/packet-transcript');
const steerRoute = await import('@/app/api/orchestrator/steer-packet/route');
const tickRoute = await import('@/app/api/orchestrator/headless-tick/route');
const transcriptRoute = await import('@/app/api/orchestrator/packet-transcript/route');
let sequence = 0;

function fixture() {
  const packetId = `queue-packet-${++sequence}`;
  const lane = createLane({ repoPath: dataDir, branch: `fix/${packetId}`,
    runtime: 'codex', packetId, sessionKey: `test-runtime:${packetId}` });
  setLaneStatus(lane.id, 'running', 'system', 'session_launched');
  const body = { packetId, message: `Add scope ${sequence}`, idempotencyKey: `queue-key-${sequence}` };
  return { lane, body };
}
function post(path: string, body: unknown = {}) {
  return new NextRequest(`http://localhost${path}`, { method: 'POST', headers: {
    authorization: `Bearer ${getOrCreateWsToken()}`, 'content-type': 'application/json',
  }, body: JSON.stringify(body) });
}
function tick() { return tickRoute.POST(post('/api/orchestrator/headless-tick')); }
function steer(body: unknown) { return steerRoute.POST(post('/api/orchestrator/steer-packet', body)); }
function pane(packetId: string) {
  return transcriptRoute.GET(new NextRequest(`http://localhost/api/orchestrator/packet-transcript?packetId=${packetId}&tail=1`, {
    headers: { authorization: `Bearer ${getOrCreateWsToken()}` },
  }));
}

beforeEach(() => { h.perform.mockReset(); h.sources.mockResolvedValue(null); h.tail.mockReset(); });
afterAll(() => { closeDb(); rmSync(dataDir, { recursive: true, force: true }); });

describe('durable packet steer delivery through production HTTP routes', () => {
  it('queues a busy steer across reopen and delivers it once on a server tick', async () => {
    const { lane, body } = fixture();
    h.perform.mockResolvedValueOnce({ ok: false, status: 'unavailable',
      retryable: true, reason: 'surface_not_ready', note: 'This worker is still finishing its current turn.' });
    const response = await steer(body);
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toMatchObject({ result: { deliveryState: 'queued' } });
    closeDb();
    expect(readSessionSteerTranscriptEvents(lane.sessionKey!)).toMatchObject([
      { text: body.message, failed: false, note: expect.stringContaining('Queued') },
    ]);
    h.perform.mockResolvedValue({ ok: true, status: 'queued', sessionKey: lane.sessionKey, note: 'accepted' });
    expect((await tick()).status).toBe(200);
    expect((await tick()).status).toBe(200);
    expect((await steer(body)).status).toBe(200);
    expect(h.perform).toHaveBeenCalledTimes(2);
    expect(getLaneEvents(lane.id, 100).filter(event => event.verb === 'steered_packet')).toHaveLength(1);
    expect(readSessionSteerTranscriptEvents(lane.sessionKey!)).toMatchObject([
      { text: body.message, failed: false, note: expect.stringContaining('Delivered') },
    ]);
  });

  it.each([
    'Owned artifact admission held: artifact accounting changed; retry after writers settle',
    'This owned Codex session still has an active run. Wait for it to settle or interrupt it first.',
  ])('retains a pre-send refusal for automatic delivery: %s', async (note) => {
    const { lane, body } = fixture();
    h.perform.mockResolvedValueOnce({ ok: false, status: 'unavailable', note });
    const response = await steer(body);
    expect(response.status, await response.clone().text()).toBe(200);
    expect(JSON.stringify(await response.json())).not.toMatch(/admission|accounting/);
    h.perform.mockResolvedValue({ ok: true, status: 'queued', sessionKey: lane.sessionKey });
    await tick();
    expect(h.perform).toHaveBeenCalledTimes(2);
    expect(readSessionSteerTranscriptEvents(lane.sessionKey!)).toHaveLength(1);
  });

  it('does not deliver a queued steer into a replacement session', async () => {
    const { lane, body } = fixture();
    h.perform.mockResolvedValueOnce({ ok: false, status: 'unavailable', reason: 'surface_not_ready', retryable: true });
    expect((await steer(body)).status).toBe(200);
    updateLane(lane.id, { sessionKey: 'test-runtime:replacement' });
    await tick();
    expect(h.perform).toHaveBeenCalledTimes(1);
    expect(getLaneEvents(lane.id, 100).filter(event => event.verb === 'steer_failed')).toHaveLength(1);
  });

  it('keeps one failed entry and never retries an uncertain send', async () => {
    const { lane, body } = fixture();
    h.perform.mockRejectedValueOnce(new Error('transport closed after send'));
    expect((await steer(body)).status).toBe(409);
    closeDb();
    await tick();
    expect(h.perform).toHaveBeenCalledTimes(1);
    expect(readSessionSteerTranscriptEvents(lane.sessionKey!)).toMatchObject([
      { text: body.message, failed: true },
    ]);
  });

  it('does not mistake a previous failed run for failure of the active continuation', async () => {
    const { lane, body } = fixture();
    const sessionKey = `codex-owned:${body.packetId}`;
    updateLane(lane.id, { sessionKey });
    h.sources.mockResolvedValue({ stdoutPaths: [join(dataDir, 'active.jsonl')] });
    h.tail.mockResolvedValue({ surface: { lifecycle: {
      availability: 'running', lastOutcome: 'failed', lastRunMode: 'resume',
      lastRunStartedAt: new Date().toISOString(), summary: 'Active owned run in flight.',
    } } });
    h.perform.mockResolvedValue({ ok: true, status: 'queued', sessionKey, note: 'accepted' });
    const response = await steer(body);
    expect(response.status, await response.clone().text()).toBe(200);
    await tick();
    expect(h.perform).toHaveBeenCalledTimes(1);
    expect(readSessionSteerTranscriptEvents(sessionKey)).toMatchObject([{ failed: false }]);
  });

  it('claims once when server wakes race', async () => {
    const { lane, body } = fixture();
    h.perform.mockResolvedValueOnce({ ok: false, reason: 'surface_not_ready' });
    expect((await steer(body)).status).toBe(200);
    h.perform.mockResolvedValue({ ok: true, sessionKey: lane.sessionKey });
    await Promise.all([tick(), tick(), tick()]);
    expect(h.perform).toHaveBeenCalledTimes(2);
  });

  it('preserves FIFO for two pending messages on the same worker', async () => {
    const { lane, body } = fixture();
    h.perform.mockResolvedValueOnce({ ok: false, reason: 'surface_not_ready' });
    expect((await steer(body)).status).toBe(200);
    expect((await steer({ ...body, message: 'Second correction', idempotencyKey: `${body.idempotencyKey}-second` })).status).toBe(200);
    expect(h.perform).toHaveBeenCalledTimes(1);
    h.perform.mockResolvedValue({ ok: true, sessionKey: lane.sessionKey });
    await tick();
    await tick();
    expect(h.perform.mock.calls.map(([request]) => request.message)).toEqual([body.message, body.message, 'Second correction']);
  });

  it('shows one operator-readable failure for a permanent storage refusal', async () => {
    const { lane, body } = fixture();
    h.perform.mockResolvedValue({ ok: false, status: 'unavailable',
      note: 'Owned artifact admission held: retained artifacts reached the 4 GiB admission threshold' });
    const response = await steer(body);
    expect(response.status).toBe(409);
    expect(await response.text()).not.toMatch(/admission|accounting/);
    await tick();
    expect(h.perform).toHaveBeenCalledTimes(1);
    const entries = readSessionSteerTranscriptEvents(lane.sessionKey!);
    expect(entries).toMatchObject([{ failed: true }]);
    expect(entries[0].note).not.toMatch(/admission|accounting/);
  });

  it('cancels a pending message when the worker is stopped, even after a database reopen', async () => {
    const { lane, body } = fixture();
    h.perform.mockResolvedValueOnce({ ok: false, reason: 'surface_not_ready' });
    expect((await steer(body)).status).toBe(200);
    advanceCorrectionStop(`worker:${lane.sessionKey}`);
    closeDb();
    await tick();
    expect(h.perform).toHaveBeenCalledTimes(1);
    expect(readSessionSteerTranscriptEvents(lane.sessionKey!)).toMatchObject([{ failed: true }]);
  });

  it('updates the same pane HTTP entry from queued to delivered', async () => {
    const { lane, body } = fixture();
    const sessionKey = `codex-owned:${body.packetId}`;
    updateLane(lane.id, { sessionKey });
    h.perform.mockResolvedValueOnce({ ok: false, reason: 'surface_not_ready' });
    expect((await steer(body)).status).toBe(200);
    const queued = await pane(body.packetId);
    expect(queued.status).toBe(200);
    expect(await queued.json()).toMatchObject({ events: [{ type: 'steer', text: body.message, note: expect.stringContaining('Queued') }] });
    h.perform.mockResolvedValue({ ok: true, sessionKey });
    await tick();
    const delivered = await pane(body.packetId);
    expect(await delivered.json()).toMatchObject({ events: [{ type: 'steer', text: body.message, note: expect.stringContaining('Delivered') }] });
  });

  it('quarantines a crashed sender without blocking a fresh explicit message forever', async () => {
    const { lane, body } = fixture();
    const owner = probeMetadataLockProcessIdentitySync(process.pid);
    expect(owner.state).toBe('live');
    if (owner.state !== 'live') return;
    const intent = recordLaneEvent(lane.id, 'steered_packet', 'orchestrator', {
      ...body, sessionKey: lane.sessionKey, stopVersion: 0, deliveryState: 'queued',
    });
    recordLaneEvent(lane.id, 'steer_delivery', 'orchestrator', {
      steerEventId: intent.id, state: 'sending', ownerPid: 987654321, ownerIdentity: owner.identity,
    });
    expect((await steer({ ...body, message: 'Fresh explicit message', idempotencyKey: `${body.idempotencyKey}-fresh` })).status).toBe(200);
    expect(h.perform).not.toHaveBeenCalled();
    closeDb();
    await tick();
    h.perform.mockResolvedValue({ ok: true, sessionKey: lane.sessionKey });
    await tick();
    expect(h.perform).toHaveBeenCalledTimes(1);
    expect(h.perform.mock.calls[0][0].message).toBe('Fresh explicit message');
    expect(readSessionSteerTranscriptEvents(lane.sessionKey!)).toMatchObject([{ failed: true }, { failed: false }]);
  });

  it('returns queued success while pre-send process verification is unavailable', async () => {
    const { lane, body } = fixture();
    const probe = vi.spyOn(processIdentity, 'probeMetadataLockProcessIdentitySync')
      .mockReturnValueOnce({ state: 'unknown', detail: 'temporary probe failure' });
    const response = await steer(body);
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toMatchObject({ result: { deliveryState: 'queued' } });
    expect(h.perform).not.toHaveBeenCalled();
    probe.mockRestore();
    closeDb();
    h.perform.mockResolvedValue({ ok: true, sessionKey: lane.sessionKey });
    await tick();
    expect(h.perform).toHaveBeenCalledTimes(1);
  });
});
