/**
 * #2395 — only operator-authored steers carry operator standing.
 *
 * Real-path doctrine: every steer is sent through the REAL steer-packet route
 * handler with a constructed principal (worker token, operator ws-token), so the
 * persisted `steered_packet` row is the one the route actually writes. The read
 * side goes through the real `buildPacketPrompt` and the real Brain retrieval
 * merge — never the formatter or reader with hand-built corrections.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OrchestratorPacket } from '@/lib/orchestrator/types';

const h = vi.hoisted(() => ({ perform: vi.fn() }));

vi.mock('@/lib/runtime/actions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/runtime/actions')>();
  return { ...actual, performRuntimeAction: h.perform };
});
vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: vi.fn(async () => {}) }));
vi.mock('@/lib/command-center/snapshot', () => ({ invalidateCommandCenterSnapshotCaches: vi.fn() }));
vi.mock('@/lib/mobile/inbox', () => ({ invalidateInboxCache: vi.fn() }));

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-steer-standing-'));
const repoPath = mkdtempSync(join(os.tmpdir(), 'o8-steer-standing-repo-'));
const OPERATOR_TOKEN = 'operator-steer-standing-0123456789abcdef';
const WORKER_TOKEN = 'local-worker-steer-standing-cafebabe012345';
writeFileSync(join(dataDir, 'ws-token'), `${OPERATOR_TOKEN}\n`, 'utf8');
writeFileSync(join(dataDir, 'worker-token'), `${WORKER_TOKEN}\n`, 'utf8');
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;

const steerRoute = await import('@/app/api/orchestrator/steer-packet/route');
const idempotency = await import('@/lib/orchestrator/idempotency-store');
const { closeDb, getSqlite } = await import('@/lib/db');
const { createLane } = await import('@/lib/lane/registry');
const { mintPacketWorkerToken } = await import('@/lib/auth/packet-worker-token');
const { buildPacketPrompt } = await import('@/lib/orchestrator/packet-prompt');
const { rowAuthority } = await import('@/lib/cortex/qa/citations');

afterAll(() => {
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(repoPath, { recursive: true, force: true });
});

beforeEach(() => {
  h.perform.mockReset();
  idempotency.__resetIdempotencyStoreForTests();
});

function packetFixture(id: string): OrchestratorPacket {
  return {
    id,
    workspaceTargetPath: null,
    branchTarget: null,
    referenceLabel: 'PKT-2395',
    title: 'fix the ledger migration',
    summary: 'Fix the migration.',
    status: 'draft',
    queueState: 'queued',
    releaseState: 'pending',
    blockedReason: null,
    lane: null,
    review: null,
    runtime: 'codex',
    dependencyPacketIds: [],
    dependencyLabels: [],
    attemptCount: 1,
    lastEventAt: '2026-09-17T00:00:00.000Z',
    lastEventLabel: 'rerun',
    recoveryCount: 0,
    typecheckAutoRetries: 0,
    orchestratorThreadId: null,
  } as unknown as OrchestratorPacket;
}

function steerableLane(packetId: string) {
  // A non-codex session key skips the owned-session startup probe.
  const lane = createLane({
    repoPath,
    branch: `o8/${packetId}`,
    runtime: 'codex',
    packetId,
    sessionKey: `test-runtime:${packetId}`,
  });
  h.perform.mockResolvedValue({
    ok: true,
    action: 'steer',
    surfaceId: lane.sessionKey,
    sessionKey: lane.sessionKey,
    runtime: lane.runtime,
    status: 'sent',
    note: 'steered',
  });
  return lane;
}

function steerRequest(bearer: string, body: Record<string, unknown>, workerPacketId?: string) {
  const headers: Record<string, string> = {
    host: 'localhost:3001',
    authorization: `Bearer ${bearer}`,
    'content-type': 'application/json',
  };
  if (workerPacketId) headers['x-o8-worker-packet-id'] = workerPacketId;
  return new NextRequest('http://localhost:3001/api/orchestrator/steer-packet', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

function steerEventCount(laneId: string): number {
  const row = getSqlite().prepare(
    "SELECT COUNT(*) AS count FROM lane_events WHERE lane_id = ? AND verb = 'steered_packet'",
  ).get(laneId) as { count: number };
  return row.count;
}

describe('#2395 steer route — a worker cannot author a correction', () => {
  it('legacy worker token → 403, no steer row, nothing in the next prompt', async () => {
    const packetId = 'pkt-2395-worker-legacy';
    const lane = steerableLane(packetId);
    const message = 'Worker-authored steer that must never become a correction';

    const res = await steerRoute.POST(steerRequest(WORKER_TOKEN, {
      packetId,
      message,
      source: 'operator',
      idempotencyKey: 'steer-2395-worker-legacy',
    }));
    expect(res.status).toBe(403);
    expect(h.perform).not.toHaveBeenCalled();
    expect(steerEventCount(lane.id)).toBe(0);

    const prompt = await buildPacketPrompt(packetFixture(packetId), []);
    expect(prompt).not.toContain(message);
    expect(prompt).not.toContain('Operator corrections for this packet');
    expect(prompt).not.toContain('Machine steering for this packet');
  });

  it('packet-bound worker token steering its own packet → 403, no steer row', async () => {
    const packetId = 'pkt-2395-worker-bound';
    const lane = steerableLane(packetId);
    const message = 'Packet-bound worker steer claiming operator standing';

    const res = await steerRoute.POST(steerRequest(mintPacketWorkerToken(packetId), {
      packetId,
      message,
      source: 'operator',
      idempotencyKey: 'steer-2395-worker-bound',
    }, packetId));
    expect(res.status).toBe(403);
    expect(steerEventCount(lane.id)).toBe(0);

    const prompt = await buildPacketPrompt(packetFixture(packetId), []);
    expect(prompt).not.toContain(message);
  });
});

describe('#2395 steer route — operator standing versus machine steering', () => {
  const OPERATOR_MESSAGE = 'Keep the ledger migration additive and never rename the column';
  const MACHINE_MESSAGE = 'Typecheck failed in the ledger migration, fix the column type';

  it('an operator steer through the route surfaces as an operator correction', async () => {
    const packetId = 'pkt-2395-operator';
    const lane = steerableLane(packetId);

    const res = await steerRoute.POST(steerRequest(OPERATOR_TOKEN, {
      packetId,
      message: OPERATOR_MESSAGE,
      source: 'operator',
      idempotencyKey: 'steer-2395-operator',
    }));
    expect(res.status).toBe(200);
    expect(steerEventCount(lane.id)).toBe(1);

    const prompt = await buildPacketPrompt(packetFixture(packetId), []);
    expect(prompt).toContain('Operator corrections for this packet');
    expect(prompt).toContain(`[steered `);
    expect(prompt).toContain(OPERATOR_MESSAGE);
    expect(prompt).not.toContain('Machine steering for this packet');
  });

  it('an orchestrator steer (the MCP steer_packet body) surfaces only as machine steering', async () => {
    const packetId = 'pkt-2395-machine';
    const lane = steerableLane(packetId);

    const res = await steerRoute.POST(steerRequest(OPERATOR_TOKEN, {
      packetId,
      message: MACHINE_MESSAGE,
      source: 'orchestrator',
      idempotencyKey: 'steer-2395-machine',
    }));
    expect(res.status).toBe(200);
    expect(steerEventCount(lane.id)).toBe(1);

    const prompt = await buildPacketPrompt(packetFixture(packetId), []);
    expect(prompt).not.toContain('Operator corrections for this packet');
    expect(prompt).toContain('Machine steering for this packet');
    expect(prompt).toContain(`[machine steer via orchestrator `);
    expect(prompt).toContain(MACHINE_MESSAGE);
  });

  it('the Brain cites the operator steer at operator authority and the machine steer lower', async () => {
    const { retrieveAll, unionMerge } = await import('@/lib/cortex/qa/retrieve');
    const results = await retrieveAll({
      question: 'why was the ledger migration steered?',
      repoPath,
    });
    const merged = unionMerge(results).filter((row) => row.citation.kind === 'correction');
    const operatorRow = merged.find((row) => row.fields.body === OPERATOR_MESSAGE);
    const machineRow = merged.find((row) => row.fields.body === MACHINE_MESSAGE);

    expect(operatorRow?.fields.standing).toBe('operator');
    expect(operatorRow?.citation.title).toMatch(/^Operator steered:/);
    expect(rowAuthority(operatorRow!)).toBe(0.95);

    expect(machineRow?.fields.standing).toBe('machine');
    expect(machineRow?.citation.title).toMatch(/^Machine steer via orchestrator:/);
    expect(rowAuthority(machineRow!)).toBeLessThanOrEqual(0.6);
    expect(merged.indexOf(operatorRow!)).toBeLessThan(merged.indexOf(machineRow!));
  });
});
