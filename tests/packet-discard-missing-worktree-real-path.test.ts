import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';

import type { Lane } from '@/lib/lane/types';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-packet-discard-missing-'));
const wsToken = 'operator-packet-discard-missing-token-0123456789';
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;
writeFileSync(join(dataDir, 'ws-token'), `${wsToken}\n`, 'utf8');

const discardRoute = await import('@/app/api/orchestrator/discard-packet/route');
const stopRoute = await import('@/app/api/orchestrator/stop-packet/route');
const { closeDb } = await import('@/lib/db');
const {
  createLane,
  getLane,
  getLaneEvents,
  setLaneStatus,
} = await import('@/lib/lane/registry');
const { reconcileOrphanedWorktrees } = await import('@/lib/lane/reconcile');
const { recordLaneEvent } = await import('@/lib/lane/events');
const {
  bindReviewTurnAbortController,
  startReviewTurn,
} = await import('@/lib/lane/review-turn-state');
const {
  readOrchestratorControlPlaneState,
  writeOrchestratorControlPlaneState,
} = await import('@/lib/orchestrator/control-plane');
const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const { listInboxItems } = await import('@/lib/supervisor/inbox');

afterAll(() => {
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

function operatorRequest(path: string, body: Record<string, unknown>) {
  return new NextRequest(`http://localhost:3001${path}`, {
    method: 'POST',
    headers: {
      host: 'localhost:3001',
      authorization: `Bearer ${wsToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

function persistPacket(input: {
  packetId: string;
  repoPath: string;
  worktreePath: string;
  sessionKey?: string | null;
  blockedReason?: string | null;
}) {
  const lane = createLane({
    repoPath: input.repoPath,
    worktreePath: input.worktreePath,
    branch: `fix/${input.packetId}`,
    baseBranch: 'main',
    runtime: 'codex',
    label: `Packet ${input.packetId}`,
    packetId: input.packetId,
    sessionKey: input.sessionKey ?? undefined,
  });
  setLaneStatus(
    lane.id,
    input.blockedReason ? 'awaiting_orchestrator' : 'reviewing',
    'system',
    input.blockedReason ?? 'review_requested',
  );
  const packet = {
    id: input.packetId,
    referenceLabel: '#1995',
    title: 'Close a packet whose worktree is gone',
    summary: 'The worker completed before the worktree disappeared.',
    workspaceTargetPath: input.repoPath,
    branchTarget: lane.branch,
    runtime: 'codex',
    dependencyLabels: [],
    dependencyPacketIds: [],
    queueState: 'held',
    releaseState: 'pending',
    status: input.blockedReason ? 'blocked' : 'awaiting_review',
    blockedReason: input.blockedReason ?? null,
    lane: {
      tileId: lane.id,
      tabId: lane.id,
      repoPath: input.repoPath,
      worktreePath: input.worktreePath,
      runtime: 'codex',
      laneId: lane.id,
      sessionKey: input.sessionKey ?? null,
    },
    review: null,
  } as OrchestratorPacket;
  writeOrchestratorControlPlaneState({
    ...createEmptyOrchestratorMissionState(),
    missionId: `mission-${input.packetId}`,
    repoPath: input.repoPath,
    runtime: 'codex',
    packets: [packet],
    updatedAt: new Date().toISOString(),
  });
  return lane;
}

function recordCleanWorkerExit(lane: Lane, sessionKey: string) {
  recordLaneEvent(lane.id, 'runtime_process_exit', 'system', {
    runtime: lane.runtime,
    surfaceId: sessionKey,
    runId: `run-${lane.id}`,
    exitCode: 0,
    signal: null,
    classification: 'clean-exit',
    completedTurn: true,
  });
}

function discardRequest(packetId: string, extra: Record<string, unknown> = {}) {
  return operatorRequest('/api/orchestrator/discard-packet', {
    packetId,
    disposition: 'wontfix',
    clientMutationId: `discard-${randomUUID()}`,
    ...extra,
  });
}

describe('packet missing-worktree close paths (#1995)', () => {
  it('discard route closes after a recorded clean worker exit when the worktree is already missing', async () => {
    const packetId = 'pkt-1995-clean-exit';
    const repoPath = mkdtempSync(join(dataDir, 'clean-exit-repo-'));
    const worktreePath = join(dataDir, 'missing-clean-exit-worktree');
    const sessionKey = 'codex-worker:clean-exit';
    const lane = persistPacket({ packetId, repoPath, worktreePath, sessionKey });
    recordCleanWorkerExit(lane, sessionKey);

    const response = await discardRoute.POST(discardRequest(packetId));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      result: {
        closed: true,
        packetId,
        worktreeCleanup: 'missing',
        worktreeRemoved: false,
      },
    });
    expect(getLane(lane.id)).toMatchObject({
      status: 'archived',
      lastEventLabel: 'discarded_worktree_missing',
    });
    expect(readOrchestratorControlPlaneState().packets[0]).toMatchObject({
      status: 'archived',
      lastEventLabel: 'discarded_worktree_missing',
    });
    expect(getLaneEvents(lane.id).find((event) => event.verb === 'packet_discarded')).toMatchObject({
      payload: {
        packetId,
        worktreeCleanup: 'missing',
        reason: 'worktree_missing',
        acknowledgedMissingWorktree: false,
      },
    });
  });

  it('stop route excludes the exited worker and stops the active review turn as its own session class', async () => {
    const packetId = 'pkt-1995-stop-review';
    const repoPath = mkdtempSync(join(dataDir, 'stop-review-repo-'));
    const worktreePath = join(dataDir, 'missing-stop-review-worktree');
    const sessionKey = 'codex-worker:already-exited';
    const lane = persistPacket({ packetId, repoPath, worktreePath, sessionKey });
    recordCleanWorkerExit(lane, sessionKey);
    const reviewTurnId = startReviewTurn({
      laneId: lane.id,
      threadId: `auto-review-${lane.id}`,
      backend: 'codex',
      surface: 'auto-review',
    });
    const controller = new AbortController();
    bindReviewTurnAbortController(lane.id, reviewTurnId, controller);

    const response = await stopRoute.POST(operatorRequest('/api/orchestrator/stop-packet', { packetId }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      result: {
        ok: true,
        packetId,
        interruptedSessions: 0,
        stoppedReviewTurns: 1,
        killConfirmed: true,
      },
    });
    expect(controller.signal.aborted).toBe(true);
    expect(getLaneEvents(lane.id).find((event) => event.verb === 'review_turn_stopped')).toMatchObject({
      payload: {
        reviewTurnId,
        sessionClass: 'review',
        reason: 'packet_stopped',
        abortRequested: true,
      },
    });
  });

  it('discard route requires acknowledgement for the parked missing-worktree state and the inbox carries that action', async () => {
    const packetId = 'pkt-1995-acknowledge-missing';
    const repoPath = mkdtempSync(join(dataDir, 'acknowledge-repo-'));
    const worktreePath = join(dataDir, 'missing-unverified-worktree');
    const lane = persistPacket({ packetId, repoPath, worktreePath });

    await expect(reconcileOrphanedWorktrees()).resolves.toBe(0);
    expect(getLane(lane.id)).toMatchObject({
      status: 'awaiting_orchestrator',
      lastEventLabel: 'worktree_missing_unverified',
    });
    expect(listInboxItems({ includeAllProjects: true }).find((item) => item.packetId === packetId)).toMatchObject({
      kind: 'packet_missing',
      status: 'human_required',
      payload: {
        recoveryAction: 'acknowledge_missing_worktree',
        laneId: lane.id,
        worktreePath,
      },
    });

    const refused = await discardRoute.POST(discardRequest(packetId));
    expect(refused.status).toBe(409);
    await expect(refused.json()).resolves.toMatchObject({
      ok: false,
      error: { code: 'worktree_missing_unverified' },
    });

    const acknowledged = await discardRoute.POST(discardRequest(packetId, {
      acknowledgeMissingWorktree: true,
    }));
    expect(acknowledged.status).toBe(200);
    await expect(acknowledged.json()).resolves.toMatchObject({
      ok: true,
      result: {
        closed: true,
        packetId,
        worktreeCleanup: 'missing',
      },
    });
    expect(getLane(lane.id)).toMatchObject({
      status: 'archived',
      lastEventLabel: 'discarded_worktree_missing',
    });
  });
});
