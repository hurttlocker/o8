/**
 * Real-path regressions for issue #2003.
 *
 * The review case drives the durable queue, real quota-fallback turn wrapper,
 * persisted lane events, and submit-review route. The retry case drives the
 * reset route against a real Git worktree and persisted awaiting-input lane.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { NextRequest } from 'next/server';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';

const reviewer = vi.hoisted(() => ({
  active: false,
  holdNextTurn: false,
  signals: [] as AbortSignal[],
  threadIds: [] as string[],
  ensureStatuses: [] as Array<'ready' | 'busy'>,
  releaseHeldTurns: [] as Array<() => void>,
}));

vi.mock('@/lib/lane/orchestrator-backends/registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/lane/orchestrator-backends/registry')>();
  const backend = {
    id: 'claude' as const,
    label: 'Test reviewer',
    peekSession: () => ({
      sessionName: 'issue-2003-reviewer',
      status: reviewer.active ? 'busy' as const : 'ready' as const,
    }),
    ensureSession: () => {
      const status = reviewer.active ? 'busy' as const : 'ready' as const;
      reviewer.ensureStatuses.push(status);
      return { sessionName: 'issue-2003-reviewer', status };
    },
    sendTurn: async (
      _repoPath: string,
      _message: string,
      onEvent: (event: { type: 'text'; text: string }) => void,
      options?: { threadId?: string | null; signal?: AbortSignal },
    ) => {
      reviewer.threadIds.push(options?.threadId ?? '');
      if (options?.signal) reviewer.signals.push(options.signal);
      reviewer.active = true;

      if (reviewer.holdNextTurn) {
        reviewer.holdNextTurn = false;
        await new Promise<void>((resolve, reject) => {
          let settled = false;
          const finish = (error?: Error) => {
            if (settled) return;
            settled = true;
            reviewer.active = false;
            if (error) reject(error);
            else resolve();
          };
          reviewer.releaseHeldTurns.push(() => finish());
          const abort = () => finish(new Error(String(options?.signal?.reason ?? 'aborted')));
          if (options?.signal?.aborted) abort();
          else options?.signal?.addEventListener('abort', abort, { once: true });
        });
        return;
      }

      try {
        onEvent({ type: 'text', text: 'Reviewed. No blocking findings.' });
      } finally {
        reviewer.active = false;
      }
    },
  };
  return {
    ...actual,
    getActiveReviewerBackend: () => backend,
    getOrchestratorBackend: () => backend,
  };
});

vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: vi.fn(async () => {}) }));
vi.mock('@/lib/command-center/snapshot', () => ({ invalidateCommandCenterSnapshotCaches: vi.fn() }));
vi.mock('@/lib/mobile/inbox', () => ({ invalidateInboxCache: vi.fn() }));

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-issue-2003-data-'));
const wsToken = 'issue-2003-operator-token-0123456789abcdef';
writeFileSync(join(dataDir, 'ws-token'), `${wsToken}\n`, 'utf8');
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;

const tempDirs: string[] = [];

const { closeDb, getSqlite } = await import('@/lib/db');
const reviewRoute = await import('@/app/api/orchestrator/review/route');
const resetRoute = await import('@/app/api/orchestrator/reset-packet/route');
const { drainReviewQueue, triggerAutoReview } = await import('@/lib/lane/auto-review');
const {
  createLane,
  getLane,
  getLaneEvents,
  setLaneStatus,
} = await import('@/lib/lane/registry');
const {
  readOrchestratorControlPlaneState,
  writeOrchestratorControlPlaneState,
} = await import('@/lib/orchestrator/control-plane');
const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');

function git(repoDir: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: repoDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function commitFile(repoDir: string, path: string, contents: string, message: string): string {
  const absolutePath = join(repoDir, path);
  mkdirSync(join(absolutePath, '..'), { recursive: true });
  writeFileSync(absolutePath, contents, 'utf8');
  git(repoDir, ['add', '--', path]);
  git(repoDir, ['commit', '-q', '-m', message]);
  return git(repoDir, ['rev-parse', 'HEAD']);
}

function createRepo(branch: string): string {
  const repoDir = mkdtempSync(join(os.tmpdir(), 'o8-issue-2003-repo-'));
  tempDirs.push(repoDir);
  git(repoDir, ['init', '-q', '-b', 'main']);
  git(repoDir, ['config', 'user.email', 'o8@example.test']);
  git(repoDir, ['config', 'user.name', 'o8-test']);
  commitFile(repoDir, 'README.md', 'fixture\n', 'base');
  git(repoDir, ['checkout', '-q', '-b', branch]);
  return repoDir;
}

function packetFixture(input: {
  packetId: string;
  repoPath: string;
  branch: string;
  laneId?: string;
}): OrchestratorPacket {
  return {
    id: input.packetId,
    referenceLabel: input.packetId,
    title: input.packetId,
    summary: input.packetId,
    workspaceTargetPath: input.repoPath,
    branchTarget: input.branch,
    runtime: 'codex',
    dependencyLabels: [],
    dependencyPacketIds: [],
    queueState: input.laneId ? 'queued' : 'held',
    releaseState: 'pending',
    status: input.laneId ? 'awaiting_review' : 'blocked',
    blockedReason: input.laneId ? null : 'Awaiting operator input',
    lastEventAt: null,
    lastEventLabel: null,
    archivedAt: null,
    review: null,
    lane: input.laneId ? {
      tileId: input.laneId,
      tabId: input.laneId,
      repoPath: input.repoPath,
      worktreePath: input.repoPath,
      runtime: 'codex',
      laneId: input.laneId,
      sessionKey: null,
    } : null,
  };
}

function persistCurrentMission(repoPath: string, packet: OrchestratorPacket): void {
  const state = createEmptyOrchestratorMissionState();
  state.missionId = `mission-${packet.id}`;
  state.repoPath = repoPath;
  state.prompt = packet.summary;
  state.summary = packet.summary;
  state.packets = [packet];
  writeOrchestratorControlPlaneState(state);
}

function operatorPost(path: string, body: Record<string, unknown>): NextRequest {
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

function queueRows(laneId: string) {
  return getSqlite().prepare(
    `SELECT id, status, head_sha, last_error
       FROM review_queue
      WHERE lane_id = ?
      ORDER BY rowid ASC`,
  ).all(laneId) as Array<{
    id: string;
    status: string;
    head_sha: string | null;
    last_error: string | null;
  }>;
}

beforeEach(() => {
  reviewer.active = false;
  reviewer.holdNextTurn = false;
  reviewer.signals = [];
  reviewer.threadIds = [];
  reviewer.ensureStatuses = [];
  while (reviewer.releaseHeldTurns.length > 0) reviewer.releaseHeldTurns.pop()!();
});

afterAll(async () => {
  while (reviewer.releaseHeldTurns.length > 0) reviewer.releaseHeldTurns.pop()!();
  await new Promise((resolve) => setTimeout(resolve, 25));
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe('superseded active reviewer turn (#2003)', () => {
  it('aborts head A, starts head B without a busy deferral, and accepts head B through submit_review', async () => {
    const packetId = 'pkt-review-supersede-2003';
    const branch = 'inline/review-supersede-2003';
    const repoDir = createRepo(branch);
    const lane = createLane({
      repoPath: repoDir,
      worktreePath: repoDir,
      branch,
      baseBranch: 'main',
      runtime: 'codex',
      label: 'review supersede fixture',
      packetId,
    });
    const headA = commitFile(repoDir, 'result-a.txt', 'head A\n', 'head A');
    setLaneStatus(lane.id, 'reviewing', 'system', 'review_requested');
    persistCurrentMission(repoDir, packetFixture({ packetId, repoPath: repoDir, branch, laneId: lane.id }));

    triggerAutoReview(getLane(lane.id)!);
    reviewer.holdNextTurn = true;
    const firstDrain = drainReviewQueue();
    await vi.waitFor(() => {
      expect(reviewer.signals).toHaveLength(1);
      expect(getLaneEvents(lane.id, 100).some((event) => (
        event.verb === 'review_turn_started' && event.payload.expectedHeadSha === headA
      ))).toBe(true);
    });
    const headASignal = reviewer.signals[0]!;
    expect(headASignal.aborted).toBe(false);

    const headB = commitFile(repoDir, 'result-b.txt', 'head B\n', 'head B');
    triggerAutoReview(getLane(lane.id)!);

    expect(headASignal.aborted).toBe(true);
    expect(headASignal.reason).toBe('superseded');
    expect(getLaneEvents(lane.id, 100).find((event) => event.verb === 'review_turn_stopped')).toMatchObject({
      payload: {
        reason: 'superseded',
        abortRequested: true,
      },
    });
    expect(queueRows(lane.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'completed', head_sha: headA }),
      expect.objectContaining({ status: 'pending', head_sha: headB }),
    ]));

    await firstDrain;

    const reviewResponse = await reviewRoute.POST(operatorPost('/api/orchestrator/review', {
      packetId,
      findings: [],
      approved: true,
      reviewedHeadSha: headB,
      clientMutationId: 'review-head-b-after-supersede-2003',
    }));
    expect(reviewResponse.status).toBe(200);
    await expect(reviewResponse.json()).resolves.toMatchObject({
      ok: true,
      result: {
        recorded: true,
        reviewedHeadSha: headB,
      },
    });
    expect(getLaneEvents(lane.id, 100).filter((event) => event.verb === 'review_head_drift_rejected')).toHaveLength(0);

    await drainReviewQueue();

    expect(getLaneEvents(lane.id, 200).some((event) => (
      event.verb === 'review_turn_started' && event.payload.expectedHeadSha === headB
    ))).toBe(true);
    expect(getLaneEvents(lane.id, 200).filter((event) => (
      event.verb === 'review_deferred' && event.payload.reason === 'Reviewer session busy'
    ))).toHaveLength(0);
    expect(reviewer.ensureStatuses).toEqual(['ready', 'ready']);
  });
});

describe('retry_packet awaiting-input salvage (#2003)', () => {
  it('moves one clean committed awaiting-input lane to review without a worker relaunch', async () => {
    const packetId = 'pkt-awaiting-input-salvage-2003';
    const branch = 'inline/awaiting-input-salvage-2003';
    const repoDir = createRepo(branch);
    const lane = createLane({
      repoPath: repoDir,
      worktreePath: repoDir,
      branch,
      baseBranch: 'main',
      runtime: 'codex',
      label: 'awaiting input salvage fixture',
      packetId,
    });
    const committedHead = commitFile(repoDir, 'worker-result.txt', 'finished work\n', 'worker result');
    setLaneStatus(lane.id, 'awaiting_input', 'system', 'approval_required');

    // A durable awaiting-input lane can remain after its live packet.lane
    // binding clears. retry_packet must recover only this unambiguous row.
    persistCurrentMission(repoDir, packetFixture({ packetId, repoPath: repoDir, branch }));

    const response = await resetRoute.POST(operatorPost('/api/orchestrator/reset-packet', {
      packetId,
      reason: 'review the clean committed result',
      clearWorktree: false,
      idempotencyKey: 'retry-awaiting-input-salvage-2003',
    }));
    expect(response.status).toBe(200);
    const body = await response.json() as {
      ok: boolean;
      result: { reset: boolean; salvaged: boolean; laneId: string; note: string };
    };
    expect(body).toMatchObject({
      ok: true,
      result: {
        reset: false,
        salvaged: true,
        laneId: expect.stringMatching(/^lane-/),
      },
    });
    expect(body.result.note).toContain('no worker was relaunched');

    const packet = readOrchestratorControlPlaneState().packets.find((candidate) => candidate.id === packetId);
    expect(packet).toMatchObject({
      status: 'awaiting_review',
      lastEventLabel: 'retry_salvaged_work',
      lane: {
        laneId: body.result.laneId,
        worktreePath: repoDir,
        sessionKey: null,
      },
    });
    expect(getLane(body.result.laneId)).toMatchObject({
      status: 'reviewing',
      packetId,
      worktreePath: repoDir,
      sessionKey: null,
    });
    expect(getLane(lane.id)).toMatchObject({
      status: 'archived',
      packetId: '',
      worktreePath: null,
    });
    expect(git(repoDir, ['rev-parse', 'HEAD'])).toBe(committedHead);
    expect(git(repoDir, ['status', '--porcelain'])).toBe('');
  });
});
