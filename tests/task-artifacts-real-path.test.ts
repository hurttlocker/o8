/**
 * Interactive task artifacts (#1699) — real entry-point coverage.
 *
 * Drives the actual route handlers against persisted state: a worker creates
 * an artifact through its packet-bound token, the operator submits through
 * the return-channel route, the exact validated payload reaches the packet's
 * warm session exactly once (steerPacket at the module seam), every refusal
 * lands as a receipt, thread targets hand off to the stamped turn the
 * realtime server marks delivered, and all of it survives a database restart
 * without replaying a prior submission. The hostile-frame gate runs through
 * the same validator the desktop host uses.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/realtime/publisher', () => ({
  publishRealtimeMutation: vi.fn(async () => {}),
  requestRealtimeRefresh: vi.fn(async () => {}),
  publishArtifactRecorded: vi.fn(async () => {}),
  publishCortexChange: vi.fn(async () => {}),
}));

const steerPacketMock = vi.hoisted(() => vi.fn(async (input: { packetId: string; message: string }) => ({
  packetId: input.packetId,
  laneId: 'lane-from-mock',
  note: 'steered by fixture',
})));
vi.mock('@/lib/orchestrator/operator-mission-service', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/orchestrator/operator-mission-service')>(),
  steerPacket: steerPacketMock,
}));

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-task-artifacts-'));
const WORKER_TOKEN = 'local-worker-token-cafebabe0123456789abcdef01';
const WS_TOKEN = 'operator-ws-token-0123456789abcdefaaaa';
writeFileSync(join(dataDir, 'worker-token'), `${WORKER_TOKEN}\n`, 'utf-8');
writeFileSync(join(dataDir, 'ws-token'), `${WS_TOKEN}\n`, 'utf-8');
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, stdio: 'pipe' }).toString('utf8').trim();
}

function makeRepo(name: string): string {
  const repo = join(dataDir, name);
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, '-c', 'user.email=t@o8.test', '-c', 'user.name=o8-test', 'commit', '--allow-empty', '-q', '-m', 'init');
  return repo;
}

const create = await import('@/app/api/task-artifacts/route');
const one = await import('@/app/api/task-artifacts/[id]/route');
const actions = await import('@/app/api/task-artifacts/[id]/actions/route');
const { createLane, getLaneEvents, setLaneStatus } = await import('@/lib/lane/registry');
const { mintPacketWorkerToken } = await import('@/lib/auth/packet-worker-token');
const { writePersistedLlmChat } = await import('@/lib/llm/chat-history-store');
const { markThreadActionDelivered } = await import('@/lib/task-artifacts/service');
const { validateFrameMessage } = await import('@/lib/task-artifacts/bridge-protocol');
const { closeDb } = await import('@/lib/db');

const BASE = 'http://localhost:3001/api/task-artifacts';

/** Operator bearer by default; pass a worker token to act as a packet worker, or null for no credential. */
function req(url: string, init: { method?: string; body?: unknown; token?: string | null } = {}): NextRequest {
  const token = init.token === undefined ? WS_TOKEN : init.token;
  return new NextRequest(url, {
    method: init.method ?? 'GET',
    headers: {
      host: 'localhost:3001',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

const triageActions = [{
  name: 'submit',
  label: 'Send triage',
  schema: {
    fields: { note: { type: 'string', maxLength: 200 } },
    rows: { fields: { issue: { type: 'integer', required: true }, priority: { type: 'string', required: true, enum: ['p1', 'p2', 'p3', 'park'] } }, maxRows: 20 },
  },
}];
const html = '<form id="t"><input name="note"></form><script>window.o8.onCollect(function () { return { rows: [] }; });</script>';

let nonceSeq = 0;
const nonce = () => `nonce-${Date.now()}-${(nonceSeq += 1)}`;

describe('task artifacts — real path', () => {
  const repo = makeRepo('repo-packet');
  const packetId = `pkt-${crypto.randomUUID()}`;
  const lane = createLane({ repoPath: repo, branch: 'issue/1699', runtime: 'codex', packetId, sessionKey: 'codex-owned:fixture', worktreePath: repo, label: 'triage' });
  const workerToken = mintPacketWorkerToken(packetId);
  let packetArtifactId = '';
  let acceptedNonce = '';

  it('a packet worker attaches an artifact to its own packet, and only its own', async () => {
    const created = await create.POST(req(BASE, { method: 'POST', token: workerToken, body: { title: 'Issue triage', html, actions: triageActions } }));
    expect(created.status).toBe(201);
    const body = await created.json() as { ok: boolean; result: { artifact: { id: string; target: Record<string, unknown>; originHead: string | null; html?: string } } };
    expect(body.ok).toBe(true);
    packetArtifactId = body.result.artifact.id;
    expect(body.result.artifact.target).toMatchObject({ kind: 'packet', packetId, laneId: lane.id, repoPath: repo, sessionKey: 'codex-owned:fixture' });
    expect(body.result.artifact.originHead).toBe(git(repo, 'rev-parse', 'HEAD'));
    expect(body.result.artifact.html).toBeUndefined();
    expect(getLaneEvents(lane.id, 50)).toEqual(expect.arrayContaining([
      expect.objectContaining({ verb: 'task_artifact_created', payload: expect.objectContaining({ artifactId: packetArtifactId, actions: ['submit'] }) }),
    ]));

    const other = await create.POST(req(BASE, { method: 'POST', token: workerToken, body: { title: 'x', html, actions: triageActions, packetId: 'pkt-someone-else' } }));
    expect(other.status).toBe(403);
    const thread = await create.POST(req(BASE, { method: 'POST', token: workerToken, body: { title: 'x', html, actions: triageActions, threadId: 'thoughts-1', repoPath: repo } }));
    expect(thread.status).toBe(403);
    const unbound = await create.POST(req(BASE, { method: 'POST', token: WORKER_TOKEN, body: { title: 'x', html, actions: triageActions } }));
    expect(unbound.status).toBe(403);
    const anonymous = await create.POST(req(BASE, { method: 'POST', token: null, body: { title: 'x', html, actions: triageActions, threadId: 'thoughts-1', repoPath: repo } }));
    expect(anonymous.status).toBe(401);
  });

  it('the operator reads the artifact with its html and a writable verdict', async () => {
    const res = await one.GET(req(`${BASE}/${packetArtifactId}`), params(packetArtifactId));
    expect(res.status).toBe(200);
    const body = await res.json() as { result: { artifact: { html: string }; writability: { writable: boolean; reason: string | null } } };
    expect(body.result.artifact.html).toBe(html);
    expect(body.result.writability).toEqual(expect.objectContaining({ writable: true, reason: null }));

    const asWorker = await one.GET(req(`${BASE}/${packetArtifactId}`, { token: workerToken }), params(packetArtifactId));
    expect(asWorker.status).toBe(200);
    const asOtherWorker = await one.GET(req(`${BASE}/${packetArtifactId}`, { token: mintPacketWorkerToken('pkt-other') }), params(packetArtifactId));
    expect(asOtherWorker.status).toBe(403);
  });

  it('a valid submission reaches the packet session exactly once, with the exact payload and a receipt', async () => {
    acceptedNonce = nonce();
    const payload = { note: 'first pass', rows: [{ issue: 1665, priority: 'p2' }, { issue: 1875, priority: 'park' }] };
    const target = { kind: 'packet', repoPath: repo, packetId, threadId: null };
    const res = await actions.POST(req(`${BASE}/${packetArtifactId}/actions`, { method: 'POST', body: { action: 'submit', payload, nonce: acceptedNonce, target } }), params(packetArtifactId));
    expect(res.status).toBe(200);
    const body = await res.json() as { result: { accepted: boolean; deliverVia: string; action: { id: string; delivery: string; payloadHash: string; actor: string; target: Record<string, unknown> }; wireMessage: string } };
    expect(body.result.accepted).toBe(true);
    expect(body.result.deliverVia).toBe('packet');
    expect(body.result.action).toMatchObject({ delivery: 'delivered', actor: 'operator', target: expect.objectContaining({ packetId }) });
    expect(body.result.action.payloadHash).toMatch(/^[0-9a-f]{64}$/);
    expect(steerPacketMock).toHaveBeenCalledTimes(1);
    const steer = steerPacketMock.mock.calls[0][0];
    expect(steer.packetId).toBe(packetId);
    expect(steer.message).toContain(body.result.action.id);
    expect(steer.message).toContain(JSON.stringify(payload, null, 2));
    expect(getLaneEvents(lane.id, 50)).toEqual(expect.arrayContaining([
      expect.objectContaining({ verb: 'task_artifact_action', payload: expect.objectContaining({ actionId: body.result.action.id, delivery: 'delivered', payloadHash: body.result.action.payloadHash }) }),
    ]));

    const tooSoon = await actions.POST(req(`${BASE}/${packetArtifactId}/actions`, { method: 'POST', body: { action: 'submit', payload: { rows: [{ issue: 1, priority: 'p1' }] }, nonce: nonce(), target } }), params(packetArtifactId));
    expect(tooSoon.status).toBe(422);
    expect(((await tooSoon.json()) as { error: { code: string } }).error.code).toBe('rate_limited');
    expect(steerPacketMock).toHaveBeenCalledTimes(1);
  });

  it('replay, target mismatch, undeclared action, schema violation, and oversize all fail closed with receipts', async () => {
    const target = { kind: 'packet', repoPath: repo, packetId, threadId: null };
    const post = (body: Record<string, unknown>) => actions.POST(req(`${BASE}/${packetArtifactId}/actions`, { method: 'POST', body }), params(packetArtifactId));
    const codeOf = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;

    const replay = await post({ action: 'submit', payload: { rows: [] }, nonce: acceptedNonce, target });
    expect(replay.status).toBe(422);
    expect(await codeOf(replay)).toBe('replayed');

    const mismatch = await post({ action: 'submit', payload: { rows: [] }, nonce: nonce(), target: { ...target, packetId: 'pkt-elsewhere' } });
    expect(await codeOf(mismatch)).toBe('target_mismatch');
    const wrongKind = await post({ action: 'submit', payload: { rows: [] }, nonce: nonce(), target: { kind: 'thread', repoPath: repo, threadId: 'thoughts-x', packetId: null } });
    expect(await codeOf(wrongKind)).toBe('target_mismatch');

    const undeclared = await post({ action: 'delete', payload: { rows: [] }, nonce: nonce(), target });
    expect(await codeOf(undeclared)).toBe('undeclared_action');

    const violation = await post({ action: 'submit', payload: { rows: [{ issue: 'nope', priority: 'urgent' }], extra: 1 }, nonce: nonce(), target });
    expect(await codeOf(violation)).toBe('schema_violation');

    const oversize = await post({ action: 'submit', payload: { note: 'x'.repeat(40_000), rows: [] }, nonce: nonce(), target });
    expect(await codeOf(oversize)).toBe('payload_too_large');

    expect(steerPacketMock).toHaveBeenCalledTimes(1);
    const receipts = await actions.GET(req(`${BASE}/${packetArtifactId}/actions`), params(packetArtifactId));
    const ledger = (await receipts.json() as { result: { actions: Array<{ delivery: string; deliveryNote: string | null }> } }).result.actions;
    expect(ledger.filter((a) => a.delivery === 'rejected').map((a) => a.deliveryNote?.split(':')[0]).sort()).toEqual(
      ['payload_too_large', 'rate_limited', 'replayed', 'schema_violation', 'target_mismatch', 'target_mismatch', 'undeclared_action'],
    );
    expect(ledger.filter((a) => a.delivery === 'delivered')).toHaveLength(1);
  });

  it('a dispatched worker cannot submit on the operator\'s behalf', async () => {
    const res = await actions.POST(req(`${BASE}/${packetArtifactId}/actions`, { method: 'POST', token: workerToken, body: { action: 'submit', payload: { rows: [] }, nonce: nonce(), target: {} } }), params(packetArtifactId));
    expect(res.status).toBe(403);
    expect(steerPacketMock).toHaveBeenCalledTimes(1);
  });

  it('a moved HEAD or a terminal packet makes the artifact read-only and blocks submission', async () => {
    git(repo, '-c', 'user.email=t@o8.test', '-c', 'user.name=o8-test', 'commit', '--allow-empty', '-q', '-m', 'moved');
    const view = await one.GET(req(`${BASE}/${packetArtifactId}`), params(packetArtifactId));
    const body = await view.json() as { result: { writability: { writable: boolean; reason: string | null } } };
    expect(body.result.writability.writable).toBe(false);
    expect(body.result.writability.reason).toMatch(/HEAD moved/);

    const blocked = await actions.POST(req(`${BASE}/${packetArtifactId}/actions`, { method: 'POST', body: { action: 'submit', payload: { rows: [] }, nonce: nonce(), target: { kind: 'packet', repoPath: repo, packetId, threadId: null } } }), params(packetArtifactId));
    expect(blocked.status).toBe(422);
    expect(((await blocked.json()) as { error: { code: string } }).error.code).toBe('read_only');

    setLaneStatus(lane.id, 'completed', 'system', 'fixture');
    const merged = await one.GET(req(`${BASE}/${packetArtifactId}`), params(packetArtifactId));
    expect(((await merged.json()) as { result: { writability: { reason: string } } }).result.writability.reason).toMatch(/completed/);
    expect(steerPacketMock).toHaveBeenCalledTimes(1);
  });

  it('a thread artifact hands off to the stamped turn, which is marked delivered exactly once on the exact thread', async () => {
    const threadRepo = makeRepo('repo-thread');
    const threadId = `thoughts-${Date.now()}`;
    writePersistedLlmChat(threadId, { messages: [{ id: 'u1', role: 'user', content: 'triage please', timestamp: Date.now() }] });
    const created = await create.POST(req(BASE, { method: 'POST', body: { title: 'Rank fixes', html, actions: [{ name: 'rank', schema: { fields: { winner: { type: 'string', required: true } } } }], threadId, repoPath: threadRepo } }));
    expect(created.status).toBe(201);
    const artifactId = ((await created.json()) as { result: { artifact: { id: string } } }).result.artifact.id;

    const listed = await create.GET(req(`${BASE}?threadId=${threadId}&repoPath=${encodeURIComponent(threadRepo)}`));
    const list = (await listed.json() as { result: { artifacts: Array<{ artifact: { id: string; html?: string }; writability: { writable: boolean } }> } }).result.artifacts;
    expect(list.map((a) => a.artifact.id)).toEqual([artifactId]);
    expect(list[0].artifact.html).toBeUndefined();
    expect(list[0].writability.writable).toBe(true);

    const res = await actions.POST(req(`${BASE}/${artifactId}/actions`, { method: 'POST', body: { action: 'rank', payload: { winner: 'b' }, nonce: nonce(), target: { kind: 'thread', repoPath: threadRepo, threadId, packetId: null } } }), params(artifactId));
    expect(res.status).toBe(200);
    const body = await res.json() as { result: { deliverVia: string; action: { id: string; delivery: string }; wireMessage: string; displayMessage: string } };
    expect(body.result.deliverVia).toBe('thread');
    expect(body.result.action.delivery).toBe('accepted');
    expect(body.result.wireMessage).toContain('"winner": "b"');
    expect(steerPacketMock).toHaveBeenCalledTimes(1);

    const stamp = { artifactId, actionId: body.result.action.id };
    expect(markThreadActionDelivered(stamp, { repoPath: threadRepo, threadId: 'thoughts-other' })).toEqual({ ok: false, reason: expect.stringContaining('not landing on the thread') });
    expect(markThreadActionDelivered(stamp, { repoPath: threadRepo, threadId })).toEqual({ ok: true });
    expect(markThreadActionDelivered(stamp, { repoPath: threadRepo, threadId })).toEqual({ ok: false, reason: 'action is already delivered' });

    // Restart: the connection closes, the next read reopens the same file.
    closeDb();
    const after = await one.GET(req(`${BASE}/${artifactId}`), params(artifactId));
    const restored = await after.json() as { result: { artifact: { html: string }; lastAction: { id: string; delivery: string } } };
    expect(restored.result.artifact.html).toBe(html);
    expect(restored.result.lastAction).toMatchObject({ id: stamp.actionId, delivery: 'delivered' });
    expect(markThreadActionDelivered(stamp, { repoPath: threadRepo, threadId })).toEqual({ ok: false, reason: 'action is already delivered' });
  });

  it('the host gate refuses hostile frame messages', () => {
    const token = 'host-minted-token';
    const base = { token, declaredActions: ['submit'] };
    expect(validateFrameMessage({ ...base, sourceIsFrame: false, data: { type: 'o8:submit', token, requestId: 'r', action: 'submit', payload: {} } })).toMatchObject({ ok: false });
    expect(validateFrameMessage({ ...base, sourceIsFrame: true, data: { type: 'o8:submit', token: 'guess', requestId: 'r', action: 'submit', payload: {} } })).toMatchObject({ ok: false });
    expect(validateFrameMessage({ ...base, sourceIsFrame: true, data: { type: 'o8:submit', token, requestId: 'r', action: 'merge', payload: {} } })).toMatchObject({ ok: false });
    expect(validateFrameMessage({ ...base, sourceIsFrame: true, data: { type: 'o8:eval', token, code: 'fetch("/api")' } })).toMatchObject({ ok: false });
    expect(validateFrameMessage({ ...base, sourceIsFrame: true, data: { type: 'o8:submit', token, requestId: 'r', action: 'submit', payload: { ok: true } } })).toMatchObject({ ok: true });
  });
});
