/**
 * Real-path spot-checks on three load-bearing seams (reachability rule).
 *
 * Each test drives the REAL entry point against PERSISTED state — not the guard
 * or helper in isolation. The three seams were chosen because each currently has
 * only direct-argument coverage, each is safety/correctness-critical, and each
 * maps to an incident class the "green tests encode the premise" gap produced:
 *
 *   A. buildPacketPrompt → session-rule inheritance (#1329). The exact incident:
 *      485 green tests, yet worker inheritance was unreachable because the packet
 *      was never wired to the thread whose rules it should carry. The existing
 *      session-rules-prompt.test.ts passes a threadId to buildSessionRulesBlock
 *      DIRECTLY; it never proves buildPacketPrompt threads packet.orchestratorThreadId
 *      into that call. This asserts the whole persisted-rule → packet field →
 *      assembled prompt chain is reachable.
 *
 *   B. worker approve_and_merge raises a governance CARD instead of merging. The
 *      merge route's worker branch is the CRIT-1 moat. This drives the real route
 *      with a worker token + a persisted lane and asserts the card is actually
 *      created (a real state effect), and that the operator path does NOT get the
 *      card — proving the principal genuinely steers the branch.
 *
 *   C. the packet typecheck retry budget survives the REAL persisted round-trip
 *      (#1108). retry-budget.test.ts checks resetPacketFields in isolation; it
 *      never proves the budget survives serialization + the normalize pass every
 *      persisted read runs. This POSTs a packet through the orchestrator-state
 *      route and reads it back, exercising persist → reconcile → normalizePacket.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import type { OrchestratorMissionState, OrchestratorPacket } from '@/lib/orchestrator/types';

vi.mock('@/lib/realtime/publisher', () => ({
  publishRealtimeMutation: vi.fn(async () => {}),
}));

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-real-path-seams-'));
const WORKER_TOKEN = 'local-worker-token-seambeef0123456789abcd';
const WS_TOKEN = 'operator-ws-token-seam-0123456789abcdef';
writeFileSync(join(dataDir, 'worker-token'), `${WORKER_TOKEN}\n`, 'utf-8');
writeFileSync(join(dataDir, 'ws-token'), `${WS_TOKEN}\n`, 'utf-8');
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;

const { buildPacketPrompt } = await import('@/lib/orchestrator/packet-prompt');
const { addSessionRule } = await import('@/lib/db/session-rules-store');
const mergeRoute = await import('@/app/api/orchestrator/merge/route');
const stateRoute = await import('@/app/api/orchestrator/state/route');
const { createLane, findLaneByPacket } = await import('@/lib/lane/registry');
const { listApprovalsForContext } = await import('@/lib/approvals/store');
const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');

function packetFixture(overrides: Partial<OrchestratorPacket> = {}): OrchestratorPacket {
  return {
    id: 'pkt-seam-1',
    referenceLabel: 'PKT-1',
    title: 'feat wire the thing',
    summary: 'Do the thing.',
    status: 'draft',
    queueState: 'queued',
    releaseState: 'pending',
    blockedReason: null,
    lane: null,
    review: null,
    runtime: 'codex',
    dependencyPacketIds: [],
    dependencyLabels: [],
    attemptCount: 0,
    lastEventAt: '2026-07-02T00:00:00.000Z',
    lastEventLabel: 'created',
    recoveryCount: 0,
    typecheckAutoRetries: 0,
    orchestratorThreadId: null,
    ...overrides,
  } as OrchestratorPacket;
}

// ── Seam A — session-rule inheritance flows through buildPacketPrompt (#1329) ──

describe('seam A — buildPacketPrompt carries the thread session rules into the worker prompt', () => {
  it('a persisted rule on the packet thread appears in the assembled dispatch prompt', async () => {
    const threadId = 'thoughts-seam-A-1';
    addSessionRule(threadId, 'DEPRIORITIZE SPEED — correctness over throughput');

    const prompt = await buildPacketPrompt(
      packetFixture({ id: 'pkt-seam-A-1', orchestratorThreadId: threadId }),
      [],
    );

    // The whole chain is reachable: persisted rule → packet.orchestratorThreadId
    // → buildSessionRulesBlock → assembled prompt. This is exactly what #1329
    // proved unreachable despite green isolation tests.
    expect(prompt).toContain('Operator session rules (binding)');
    expect(prompt).toContain('DEPRIORITIZE SPEED — correctness over throughput');
  });

  it('a packet with no thread (or a thread with no rules) carries NO rules block (negative control)', async () => {
    const prompt = await buildPacketPrompt(
      packetFixture({ id: 'pkt-seam-A-2', orchestratorThreadId: null }),
      [],
    );
    expect(prompt).not.toContain('Operator session rules (binding)');
  });
});

// ── Seam B — worker merge raises a governance card, not a merge ──────────────

function workerReq(url: string, body: unknown): NextRequest {
  return new NextRequest(url, {
    method: 'POST',
    headers: { host: 'localhost:3001', authorization: `Bearer ${WORKER_TOKEN}` },
    body: JSON.stringify(body),
  });
}
function operatorReq(url: string, body: unknown): NextRequest {
  return new NextRequest(url, {
    method: 'POST',
    headers: { host: 'localhost:3001' },
    body: JSON.stringify(body),
  });
}

describe('seam B — a dispatched worker approve_and_merge raises an operator card (CRIT-1/HIGH-4)', () => {
  const url = 'http://localhost:3001/api/orchestrator/merge';

  it('worker principal → merged:false, pending_operator_approval, and a real card is persisted', async () => {
    const packetId = 'pkt-seam-B-worker';
    const lane = createLane({ repoPath: '/tmp/o8-seam-repo', branch: 'inline/seam-b', runtime: 'codex', packetId });
    expect(findLaneByPacket(packetId)?.id).toBe(lane.id);

    const res = await mergeRoute.POST(workerReq(url, { packetId }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.result.merged).toBe(false);
    expect(json.result.status).toBe('pending_operator_approval');

    // Real state effect: the governance card actually exists in the queue.
    const cards = listApprovalsForContext({ laneId: lane.id }).filter((a) => a.status === 'pending');
    expect(cards.length).toBeGreaterThan(0);
    expect(cards.some((c) => c.policyRuleId === 'worker-merge-governance')).toBe(true);
  });

  it('operator principal on a packet with no lane → NOT the worker card path (404 lane-agnostic direct-merge branch)', async () => {
    // The operator never takes the worker-card branch — with no lane it falls
    // through to the real merge, which fails on the missing packet (not a card).
    const res = await mergeRoute.POST(operatorReq(url, { packetId: 'pkt-seam-B-nolane-operator' }));
    const json = await res.json();
    expect(json.ok).toBe(false);
    // Whatever the failure, it is NOT the worker "pending_operator_approval" card.
    expect(json.result?.status).not.toBe('pending_operator_approval');
  });
});

// ── Seam C — retry budget survives the real persisted round-trip (#1108) ─────

describe('seam C — typecheckAutoRetries survives the orchestrator-state persist → read round-trip', () => {
  const url = 'http://localhost:3001/api/orchestrator/state';

  it('a packet POSTed with a retry budget reads back with the budget intact', async () => {
    // Read the server's current mission first — mission IDENTITY is server-owned
    // (#596), so a POST with a mismatched missionId is dropped as stale. Adopt the
    // server id and append our packet, exactly how the browser reconcile POSTs.
    const seedReq = new NextRequest(url, { method: 'GET', headers: { host: 'localhost:3001' } });
    const seed = await (await stateRoute.GET(seedReq)).json();
    const current: OrchestratorMissionState = seed.mission ?? createEmptyOrchestratorMissionState();

    const mission: OrchestratorMissionState = {
      ...current,
      packets: [
        ...current.packets,
        packetFixture({ id: 'pkt-seam-C', typecheckAutoRetries: 2, recoveryCount: 3 }),
      ],
    };

    // Real persistence entry point: POST persists under the control-plane lock.
    const postRes = await stateRoute.POST(operatorReq(url, { mission }));
    expect(postRes.status).toBe(200);

    // Real read entry point: GET reconciles + normalizes the persisted state.
    const getReq = new NextRequest(url, { method: 'GET', headers: { host: 'localhost:3001' } });
    const getRes = await stateRoute.GET(getReq);
    expect(getRes.status).toBe(200);
    const json = await getRes.json();
    const packet = json.mission.packets.find((p: OrchestratorPacket) => p.id === 'pkt-seam-C');

    // The budget rides on the PACKET precisely so it survives redispatch. If the
    // normalize pass drops it (the normalizePacket-drops-fields trap), a
    // type-broken packet loops full workers forever — this asserts it persists.
    expect(packet).toBeTruthy();
    expect(packet.typecheckAutoRetries).toBe(2);
  });
});
