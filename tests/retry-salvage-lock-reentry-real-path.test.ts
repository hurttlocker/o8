// Real reset-route regression: session archival must persist usage and packet
// telemetry without recursively holding the packet-state lock. OS process
// confirmation, telemetry parsing, and the archive directory move are stubbed.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';

const reapSessions = vi.hoisted(() => ({
  killLaneSessionsConfirmed: vi.fn(),
  sessionKey: '',
  archiveGate: null as Promise<void> | null,
  archiveStarted: 0,
  archiveConfirmed: true,
}));

vi.mock('@/lib/lane/reap-sessions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/lane/reap-sessions')>();
  return {
    ...actual,
    // Only the process-confirmation boundary is stubbed; archiveLaneSessions
    // (and everything it calls) runs for real, unmodified, below.
    killLaneSessionsConfirmed: reapSessions.killLaneSessionsConfirmed,
  };
});

vi.mock('@/lib/codex/owned', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/codex/owned')>();
  return {
    ...actual,
    // The directory-move boundary is stubbed; archival, cost persistence,
    // packet projection, and both control-plane lock acquisitions run for real.
    archiveOwnedCodexSession: async (surfaceId: string) => {
      if (surfaceId !== reapSessions.sessionKey) return actual.archiveOwnedCodexSession(surfaceId);
      reapSessions.archiveStarted += 1;
      if (reapSessions.archiveGate) await reapSessions.archiveGate;
      return { archived: reapSessions.archiveConfirmed };
    },
  };
});

vi.mock('@/lib/runtimes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/runtimes')>();
  return {
    ...actual,
    getRuntime: (id: string) => {
      const adapter = actual.getRuntime(id as never);
      if (id !== 'codex' || !adapter) return adapter;
      return {
        ...adapter,
        // Real, nonzero, persistable telemetry for this exact session key —
        // everything downstream of this (persistSessionCost, patchMissionPacket,
        // withLockedState) is the real, unmocked production code.
        getTelemetry: async (sessionKey: string) => (
          sessionKey === reapSessions.sessionKey
            ? {
                totalTokens: 1_200,
                estimatedCostUsd: 0.42,
                inputTokens: 900,
                outputTokens: 300,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                costSource: 'estimate' as const,
                model: 'gpt-5.6-terra',
              }
            : adapter.getTelemetry?.(sessionKey)
        ),
      };
    },
  };
});

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-lock-reentry-data-'));
const wsToken = 'lock-reentry-operator-token-0123456789abcdef';
writeFileSync(join(dataDir, 'ws-token'), `${wsToken}\n`, 'utf8');
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;

const { closeDb, getSqlite } = await import('@/lib/db');
const resetRoute = await import('@/app/api/orchestrator/reset-packet/route');
const { createLane, getLane, listLanes, setLaneStatus, updateLane } = await import('@/lib/lane/registry');
const { readOrchestratorControlPlaneState, withLockedState, writeOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');

const tempDirs: string[] = [];
const REAL_GIT = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();

function git(cwd: string, args: string[]): string {
  return execFileSync(REAL_GIT, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function commitFile(repoDir: string, path: string, contents: string, message: string): string {
  writeFileSync(join(repoDir, path), contents, 'utf8');
  git(repoDir, ['add', '--', path]);
  git(repoDir, ['commit', '-q', '-m', message]);
  return git(repoDir, ['rev-parse', 'HEAD']);
}

function createRepo(branch: string): string {
  const repoDir = mkdtempSync(join(os.tmpdir(), 'o8-lock-reentry-repo-'));
  tempDirs.push(repoDir);
  git(repoDir, ['init', '-q', '-b', 'main']);
  git(repoDir, ['config', 'user.email', 'o8@example.test']);
  git(repoDir, ['config', 'user.name', 'o8-test']);
  commitFile(repoDir, 'README.md', 'fixture\n', 'base');
  git(repoDir, ['checkout', '-q', '-b', branch]);
  return repoDir;
}

/** Bound, paused lane with an owned session key — the live incident's shape. */
function packetFixture(input: { packetId: string; repoPath: string; branch: string; laneId: string }): OrchestratorPacket {
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
    queueState: 'held',
    releaseState: 'pending',
    status: 'blocked',
    blockedReason: 'operator_stopped',
    lastEventAt: null,
    lastEventLabel: 'operator_stopped',
    archivedAt: null,
    review: null,
    lane: {
      tileId: input.laneId,
      tabId: input.laneId,
      repoPath: input.repoPath,
      worktreePath: input.repoPath,
      runtime: 'codex',
      laneId: input.laneId,
      sessionKey: reapSessions.sessionKey,
    },
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

function operatorPost(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost:47199/api/orchestrator/reset-packet', {
    method: 'POST',
    headers: {
      host: 'localhost:47199',
      authorization: `Bearer ${wsToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  reapSessions.killLaneSessionsConfirmed.mockReset();
  reapSessions.archiveGate = null;
  reapSessions.archiveStarted = 0;
  reapSessions.archiveConfirmed = true;
});

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

afterAll(() => {
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('retry salvage packet-state lock reentrancy (#2313)', () => {
  it('settles instead of self-deadlocking when telemetry persistence re-enters the packet-state lock', async () => {
    const packetId = 'pkt-lock-reentry-2313';
    reapSessions.sessionKey = `codex-owned:${packetId}`;
    const branch = 'inline/lock-reentry-2313';
    const repoDir = createRepo(branch);
    const lane = createLane({
      repoPath: repoDir,
      worktreePath: repoDir,
      branch,
      baseBranch: 'main',
      runtime: 'codex',
      label: 'lock reentry fixture',
      packetId,
      sessionKey: reapSessions.sessionKey,
    });
    const committedHead = commitFile(repoDir, 'worker-result.txt', 'finished work\n', 'worker result');
    setLaneStatus(lane.id, 'paused', 'system', 'operator_stopped');
    persistCurrentMission(repoDir, packetFixture({ packetId, repoPath: repoDir, branch, laneId: lane.id }));
    reapSessions.killLaneSessionsConfirmed.mockResolvedValue([
      { laneId: lane.id, sessionKey: reapSessions.sessionKey, runtime: 'codex', confirmed: true, alreadyDead: true, stages: [], note: 'already stopped' },
    ]);

    // Before the fix: unreachable within the test's bound — persistRuntimeSessionCost's
    // patchMissionPacket call re-enters withLockedState while bind() still holds
    // it, and the in-process lock chain never resolves. After the fix, the lane
    // work runs before the lock is taken at all, so there is nothing to re-enter.
    const requestBody = {
      packetId,
      reason: 'retry after worker stop with real telemetry',
      clearWorktree: false,
      idempotencyKey: 'lock-reentry-2313',
    };
    const response = await resetRoute.POST(operatorPost(requestBody));

    expect(response.status).toBe(200);
    const body = await response.json() as {
      ok: boolean;
      result: { reset: boolean; salvaged: boolean; laneId?: string };
    };
    expect(body).toMatchObject({
      ok: true,
      result: { reset: false, salvaged: true, laneId: expect.stringMatching(/^lane-/) },
    });
    const salvagedLaneId = body.result.laneId!;

    expect(getLane(salvagedLaneId)).toMatchObject({
      status: 'reviewing',
      packetId,
      worktreePath: repoDir,
      sessionKey: null,
    });
    expect(getLane(lane.id)).toMatchObject({ status: 'archived', packetId: '' });
    expect(git(repoDir, ['rev-parse', 'HEAD'])).toBe(committedHead);

    const lanes = listLanes().filter((candidate) => candidate.packetId === packetId);
    expect(lanes).toHaveLength(1);
    expect(lanes[0]?.id).toBe(salvagedLaneId);

    // The telemetry really persisted through the real, unmocked cost-persistence
    // path — proof the reentrant call actually ran (and, pre-fix, actually hung).
    const usageRow = getSqlite().prepare(
      `SELECT input_tokens as inputTokens, output_tokens as outputTokens, cost_usd as costUsd
         FROM usage_logs WHERE session_key = ?`,
    ).get(reapSessions.sessionKey) as { inputTokens: number; outputTokens: number; costUsd: number } | undefined;
    expect(usageRow).toMatchObject({ inputTokens: 900, outputTokens: 300 });
    expect(usageRow?.costUsd).toBeCloseTo(0.42, 5);
    expect(readOrchestratorControlPlaneState().packets.find((packet) => packet.id === packetId)).toMatchObject({
      status: 'awaiting_review',
      lane: { laneId: salvagedLaneId },
      spendTelemetry: { inputTokens: 900, outputTokens: 300, costUsd: 0.42 },
    });
    const replay = await resetRoute.POST(operatorPost(requestBody));
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ result: { ...body.result, replayed: true } });
    expect(listLanes().filter((candidate) => candidate.packetId === packetId).map((candidate) => candidate.id)).toEqual([salvagedLaneId]);
    expect(reapSessions.killLaneSessionsConfirmed).toHaveBeenCalledTimes(1);
  }, 20_000);


  it.each(['packet-generation', 'lane-session', 'archive-refusal'] as const)(
    'preserves bindings when %s changes during archival', async (change) => {
      const packetId = `pkt-lock-${change}`;
      reapSessions.sessionKey = `codex-owned:${packetId}`;
      const branch = `inline/lock-${change}`;
      const repoDir = createRepo(branch);
      const lane = createLane({
        repoPath: repoDir, worktreePath: repoDir, branch, baseBranch: 'main',
        runtime: 'codex', label: packetId, packetId, sessionKey: reapSessions.sessionKey,
      });
      const head = commitFile(repoDir, 'worker-result.txt', 'finished work\n', 'worker result');
      setLaneStatus(lane.id, 'paused', 'system', 'operator_stopped');
      persistCurrentMission(repoDir, packetFixture({ packetId, repoPath: repoDir, branch, laneId: lane.id }));
      reapSessions.killLaneSessionsConfirmed.mockResolvedValue([
        { laneId: lane.id, sessionKey: reapSessions.sessionKey, runtime: 'codex', confirmed: true, alreadyDead: true, stages: [], note: 'already stopped' },
      ]);
      let releaseArchive!: () => void;
      reapSessions.archiveGate = new Promise<void>((resolve) => { releaseArchive = resolve; });
      const requestBody = { packetId, clearWorktree: false, idempotencyKey: `retry-${change}` };
      const pending = resetRoute.POST(operatorPost(requestBody));
      try {
        await vi.waitFor(() => expect(reapSessions.archiveStarted).toBe(1));
        if (change === 'packet-generation') {
          await withLockedState((state) => {
            state.packets[0]!.releaseStatePayload = { source: 'newer-generation' };
            state.packets[0]!.blockedReason = 'newer operator decision';
          });
        } else if (change === 'lane-session') {
          updateLane(lane.id, { sessionKey: 'codex-owned:newer-session' });
        } else {
          reapSessions.archiveConfirmed = false;
        }
      } finally {
        releaseArchive();
      }
      const response = await pending;
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        ok: false,
        error: { code: change === 'archive-refusal' ? 'session_archive_unconfirmed' : 'reset_state_changed' },
      });
      expect(getLane(lane.id)).toMatchObject({
        status: 'paused', packetId, worktreePath: repoDir,
        sessionKey: change === 'lane-session' ? 'codex-owned:newer-session' : reapSessions.sessionKey,
      });
      expect(listLanes().filter((candidate) => candidate.packetId === packetId).map((candidate) => candidate.id)).toEqual([lane.id]);
      const packet = readOrchestratorControlPlaneState().packets.find((item) => item.id === packetId);
      expect(packet).toMatchObject({ lane: { laneId: lane.id }, queueState: 'held' });
      if (change === 'packet-generation') {
        expect(packet).toMatchObject({ releaseStatePayload: { source: 'newer-generation' }, blockedReason: 'newer operator decision' });
      }
      if (change === 'archive-refusal') expect(packet?.blockedReason).toBe('session_archive_unconfirmed');
      expect(git(repoDir, ['rev-parse', 'HEAD'])).toBe(head);
      const replay = await resetRoute.POST(operatorPost(requestBody));
      expect(replay.status).toBe(409);
      expect(replay.headers.get('x-o8-idempotency-replayed')).toBe('1');
      expect(reapSessions.killLaneSessionsConfirmed).toHaveBeenCalledTimes(1);
    }, 20_000,
  );
});
