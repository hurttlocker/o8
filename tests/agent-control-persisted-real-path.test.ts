import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const h = vi.hoisted(() => ({
  archive: vi.fn(),
  kill: vi.fn(),
  publishRealtimeMutation: vi.fn(async () => true),
}));
vi.mock('@/lib/realtime/publisher', () => ({
  publishRealtimeMutation: h.publishRealtimeMutation,
}));
vi.mock('@/lib/lane/reap-sessions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/lane/reap-sessions')>();
  return {
    ...actual,
    archiveLaneSessions: h.archive,
    killLaneSessionsConfirmed: h.kill,
  };
});

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-agent-control-persisted-'));
const operatorToken = 'operator-agent-control-persisted-0123456789abcdef';
writeFileSync(join(dataDir, 'ws-token'), `${operatorToken}\n`, 'utf8');
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;

const route = await import('@/app/api/agent-control/action/route');
const { resolveAgentControlTarget } = await import('@/lib/agent-control/service');
const { createLane, getLane, getLaneEvents } = await import('@/lib/lane/registry');
const { createApproval, getApproval } = await import('@/lib/approvals/store');
const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const { recordMission } = await import('@/lib/db/missions-store');
const { readMissionRegistryEntry } = await import('@/lib/orchestrator/mission-registry');
const {
  readOrchestratorControlPlaneState,
  writeOrchestratorControlPlaneState,
} = await import('@/lib/orchestrator/control-plane');
const { closeDb } = await import('@/lib/db');

function post(body: unknown) {
  return new NextRequest('http://localhost:3001/api/agent-control/action', {
    method: 'POST',
    headers: {
      host: 'localhost:3001',
      authorization: `Bearer ${operatorToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

function git(cwd: string, args: string[]) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

afterAll(() => {
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  h.archive.mockReset();
  h.kill.mockReset();
  h.publishRealtimeMutation.mockClear();
});

describe('agent control route through persisted lane state', () => {
  it('returns one persisted target across session, repo, packet, lane, worktree, and approval', async () => {
    const packetId = 'packet-agent-control-correlated-target';
    const sessionKey = 'codex-owned:agent-control-correlated-target';
    const worktreePath = join(dataDir, 'agent-control-correlated-worktree');
    const lane = createLane({
      repoPath: process.cwd(),
      branch: 'test/agent-control-correlated-target',
      baseBranch: 'main',
      runtime: 'codex',
      label: 'agent control correlated target',
      ownership: 'managed',
      packetId,
      worktreePath,
      actor: 'system',
    });
    writeOrchestratorControlPlaneState({
      ...createEmptyOrchestratorMissionState(),
      missionId: 'mission-agent-control-correlated-target',
      repoPath: process.cwd(),
      packets: [{
        id: packetId,
        referenceLabel: 'PKT-TARGET',
        title: 'correlated control target',
        summary: 'project persisted control truth',
        workspaceTargetPath: process.cwd(),
        branchTarget: lane.branch,
        runtime: 'codex',
        dependencyLabels: [],
        dependencyPacketIds: [],
        queueState: 'queued',
        releaseState: 'pending',
        status: 'running',
        blockedReason: null,
        lastEventAt: null,
        lastEventLabel: null,
        archivedAt: null,
        review: null,
        lane: {
          tileId: 'tile-correlated-target',
          tabId: 'tab-correlated-target',
          repoPath: process.cwd(),
          worktreePath,
          runtime: 'codex',
          laneId: lane.id,
          sessionKey,
          lastHeartbeatAt: null,
          lastEventAt: null,
          lastEventLabel: null,
        },
      }],
    });
    const approval = createApproval({
      projectId: lane.projectId,
      source: 'test',
      runtime: 'codex',
      agent: 'worker',
      sessionKey,
      title: 'Review correlated target',
      description: 'Approval attached to the same durable control target.',
      summary: 'correlated target approval',
      risk: 'medium',
      metadata: { Packet: packetId, Lane: lane.id },
    });
    expect(getApproval(approval.id)?.status).toBe('pending');

    const response = await route.POST(post({
      ref: { kind: 'lane', id: lane.id },
      action: { kind: 'hold' },
      clientMutationId: 'agent-control-correlated-target-once',
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      result: {
        schema: 'o8/agent-control.result/v1',
        ref: { kind: 'lane', id: lane.id },
        target: {
          schema: 'o8/agent-control.target/v1',
          canonicalRef: { kind: 'packet', id: packetId },
          resolution: 'persisted',
          runtime: 'codex',
          surfaceId: sessionKey,
          sessionKey,
          projectId: lane.projectId,
          repoPath: process.cwd(),
          worktreePath,
          branch: lane.branch,
          baseBranch: 'main',
          laneId: lane.id,
          packetId,
          approval: { id: approval.id, status: 'pending' },
        },
      },
    });
  });

  it('prefers the packet persisted lane binding over a newer stale lane row', async () => {
    const packetId = 'packet-agent-control-bound-lane';
    const bound = createLane({
      repoPath: process.cwd(),
      branch: 'test/agent-control-bound-lane',
      runtime: 'codex',
      packetId,
      sessionKey: 'codex-owned:bound-lane',
      worktreePath: join(dataDir, 'bound-lane-worktree'),
      actor: 'system',
    });
    const stale = createLane({
      repoPath: process.cwd(),
      branch: 'test/agent-control-stale-lane',
      runtime: 'codex',
      packetId,
      sessionKey: 'codex-owned:stale-lane',
      worktreePath: join(dataDir, 'stale-lane-worktree'),
      actor: 'system',
    });
    writeOrchestratorControlPlaneState({
      ...createEmptyOrchestratorMissionState(),
      missionId: 'mission-agent-control-bound-lane',
      repoPath: process.cwd(),
      packets: [{
        id: packetId,
        referenceLabel: 'PKT-BOUND',
        title: 'bound lane truth',
        summary: 'prefer the packet binding',
        workspaceTargetPath: process.cwd(),
        branchTarget: bound.branch,
        runtime: 'codex',
        dependencyLabels: [],
        dependencyPacketIds: [],
        queueState: 'queued',
        releaseState: 'pending',
        status: 'running',
        blockedReason: null,
        lastEventAt: null,
        lastEventLabel: null,
        archivedAt: null,
        review: null,
        lane: {
          tileId: 'tile-bound-lane',
          tabId: 'tab-bound-lane',
          repoPath: process.cwd(),
          worktreePath: bound.worktreePath,
          runtime: 'codex',
          laneId: bound.id,
          sessionKey: bound.sessionKey,
          lastHeartbeatAt: null,
          lastEventAt: null,
          lastEventLabel: null,
        },
      }],
    });

    const target = await resolveAgentControlTarget({ kind: 'packet', id: packetId });

    expect(target).toMatchObject({
      canonicalRef: { kind: 'packet', id: packetId },
      resolution: 'persisted',
      laneId: bound.id,
      sessionKey: bound.sessionKey,
      worktreePath: bound.worktreePath,
    });
    expect(target.laneId).not.toBe(stale.id);
  });

  it('retains the retired target identity while reporting post-reset packet truth', async () => {
    const packetId = 'packet-agent-control-reset-receipt';
    const sessionKey = 'codex-owned:agent-control-reset-receipt';
    const branch = 'test/agent-control-reset-receipt';
    const repoPath = join(dataDir, 'agent-control-reset-receipt-repo');
    const worktreePath = join(dataDir, 'agent-control-reset-receipt-worktree');
    mkdirSync(repoPath);
    git(repoPath, ['init', '-q', '-b', 'main']);
    git(repoPath, ['config', 'user.email', 'test@o8.dev']);
    git(repoPath, ['config', 'user.name', 'o8 test']);
    writeFileSync(join(repoPath, 'base.txt'), 'base\n', 'utf8');
    git(repoPath, ['add', 'base.txt']);
    git(repoPath, ['commit', '-q', '-m', 'base']);
    git(repoPath, ['branch', branch]);
    git(repoPath, ['worktree', 'add', '-q', worktreePath, branch]);
    const lane = createLane({
      repoPath,
      branch,
      baseBranch: 'main',
      runtime: 'codex',
      packetId,
      sessionKey,
      worktreePath,
      actor: 'system',
    });
    writeOrchestratorControlPlaneState({
      ...createEmptyOrchestratorMissionState(),
      missionId: 'mission-agent-control-reset-receipt',
      repoPath,
      packets: [{
        id: packetId,
        referenceLabel: 'PKT-RESET-RECEIPT',
        title: 'reset receipt truth',
        summary: 'retain retired control identity',
        workspaceTargetPath: repoPath,
        branchTarget: branch,
        runtime: 'codex',
        dependencyLabels: [],
        dependencyPacketIds: [],
        queueState: 'queued',
        releaseState: 'pending',
        status: 'running',
        blockedReason: null,
        lastEventAt: null,
        lastEventLabel: null,
        archivedAt: null,
        review: null,
        lane: {
          tileId: 'tile-reset-receipt',
          tabId: 'tab-reset-receipt',
          repoPath,
          worktreePath,
          runtime: 'codex',
          laneId: lane.id,
          sessionKey,
          lastHeartbeatAt: null,
          lastEventAt: null,
          lastEventLabel: null,
        },
      }],
    });
    h.kill.mockResolvedValueOnce([{
      laneId: lane.id,
      sessionKey,
      runtime: 'codex',
      confirmed: false,
      alreadyDead: true,
      stages: [],
      note: 'already stopped in reset receipt test',
    }]);
    h.archive.mockResolvedValueOnce({
      targeted: 1,
      archived: 1,
      outcomes: [{ laneId: lane.id, sessionKey, runtime: 'codex', archived: true, note: 'archived' }],
      failures: [],
    });
    h.publishRealtimeMutation.mockClear();

    const response = await route.POST(post({
      ref: { kind: 'packet', id: packetId },
      action: { kind: 'reset', reason: 'prove correlated reset receipt' },
      clientMutationId: 'agent-control-reset-receipt-once',
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      result: {
        status: 'held',
        target: {
          canonicalRef: { kind: 'packet', id: packetId },
          resolution: 'persisted',
          runtime: 'codex',
          surfaceId: sessionKey,
          sessionKey,
          projectId: lane.projectId,
          repoPath,
          worktreePath,
          branch,
          baseBranch: 'main',
          laneId: lane.id,
          laneStatus: 'archived',
          packetId,
          packetStatus: 'blocked',
        },
      },
    });
    expect(readOrchestratorControlPlaneState().packets[0]).toMatchObject({
      id: packetId,
      status: 'blocked',
      queueState: 'held',
      lane: null,
    });
    expect(getLane(lane.id)).toMatchObject({
      status: 'archived',
      packetId: '',
      sessionKey,
      worktreePath: null,
    });
    expect(h.publishRealtimeMutation).toHaveBeenCalledWith(expect.objectContaining({
      mutation: expect.objectContaining({
        action: 'packet.reset',
        sessionKey,
        laneId: lane.id,
        packetId,
        repoPath,
        branch,
      }),
      refreshTargets: expect.arrayContaining(['sessionHistory']),
      sessionKeys: [sessionKey],
    }));
  });

  it('holds a real lane once and returns the persisted control receipt', async () => {
    const lane = createLane({
      repoPath: process.cwd(),
      branch: 'test/agent-control-persisted-hold',
      baseBranch: 'main',
      runtime: 'codex',
      label: 'agent control persisted hold',
      ownership: 'managed',
      actor: 'system',
    });
    const request = {
      ref: { kind: 'lane', id: lane.id },
      action: { kind: 'hold' },
      clientMutationId: 'agent-control-persisted-hold-once',
    };

    const first = await route.POST(post(request));
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({
      ok: true,
      result: {
        schema: 'o8/agent-control.result/v1',
        ok: true,
        ref: { kind: 'lane', id: lane.id },
        action: 'hold',
        status: 'held',
        laneId: lane.id,
      },
    });
    expect(getLane(lane.id)).toMatchObject({ status: 'paused', lastEventLabel: 'operator_stopped' });
    const stopEvents = () => getLaneEvents(lane.id).filter((event) => (
      event.verb === 'status_change' && event.payload.status === 'paused'
    ));
    expect(stopEvents()).toHaveLength(1);

    const replay = await route.POST(post(request));
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({
      ok: true,
      result: { action: 'hold', replayed: true },
    });
    expect(stopEvents()).toHaveLength(1);
  });

  it('holds the packet in its non-current mission before stopping the lane', async () => {
    const packetId = 'packet-agent-control-registry-hold';
    const missionId = 'mission-agent-control-registry-hold';
    const lane = createLane({
      repoPath: process.cwd(),
      branch: 'test/agent-control-registry-hold',
      baseBranch: 'main',
      runtime: 'codex',
      label: 'agent control registry hold',
      ownership: 'managed',
      packetId,
      actor: 'system',
    });
    const missionState = {
      ...createEmptyOrchestratorMissionState(),
      missionId,
      repoPath: process.cwd(),
      packets: [{
        id: packetId,
        referenceLabel: 'PKT-HOLD',
        title: 'registry hold truth',
        summary: 'persist a hold outside the current mission',
        workspaceTargetPath: process.cwd(),
        branchTarget: lane.branch,
        runtime: 'codex' as const,
        dependencyLabels: [],
        dependencyPacketIds: [],
        queueState: 'queued' as const,
        releaseState: 'pending' as const,
        status: 'running' as const,
        blockedReason: null,
        lastEventAt: null,
        lastEventLabel: null,
        archivedAt: null,
        review: null,
        lane: {
          tileId: 'tile-registry-hold',
          tabId: 'tab-registry-hold',
          repoPath: process.cwd(),
          runtime: 'codex' as const,
          laneId: lane.id,
          sessionKey: null,
          lastHeartbeatAt: null,
          lastEventAt: null,
          lastEventLabel: null,
        },
      }],
    };
    recordMission({
      id: missionId,
      repoPath: process.cwd(),
      runtime: 'codex',
      prompt: missionState.prompt,
      summary: missionState.summary,
      constraints: '',
      packetMeta: [{ id: packetId, title: 'registry hold truth', referenceLabel: 'PKT-HOLD' }],
      missionState,
      totalWaves: 1,
    });
    writeOrchestratorControlPlaneState({
      ...createEmptyOrchestratorMissionState(),
      missionId: 'different-current-mission',
    });

    const response = await route.POST(post({
      ref: { kind: 'lane', id: lane.id },
      action: { kind: 'hold' },
      clientMutationId: 'agent-control-registry-hold-once',
    }));

    expect(response.status).toBe(200);
    expect(getLane(lane.id)).toMatchObject({ status: 'paused', lastEventLabel: 'operator_stopped' });
    const packet = readMissionRegistryEntry(missionId, { includeArchived: true })?.mission.packets[0];
    expect(packet).toMatchObject({
      operatorStopped: true,
      queueState: 'held',
      status: 'blocked',
      blockedReason: 'operator_stopped',
    });
  });

  it('gives distinct concurrent terminate requests the same unconfirmed kill truth', async () => {
    let finishKill!: (value: Array<Record<string, unknown>>) => void;
    const packetId = 'packet-agent-control-concurrent-stop';
    const sessionKey = 'codex-owned:agent-control-concurrent-stop';
    const lane = createLane({
      repoPath: process.cwd(),
      branch: 'test/agent-control-concurrent-stop',
      baseBranch: 'main',
      runtime: 'codex',
      label: 'agent control concurrent stop',
      ownership: 'managed',
      packetId,
      sessionKey,
      actor: 'system',
    });
    writeOrchestratorControlPlaneState({
      ...createEmptyOrchestratorMissionState(),
      missionId: 'mission-agent-control-concurrent-stop',
      repoPath: process.cwd(),
      packets: [{
        id: packetId,
        referenceLabel: 'PKT-STOP',
        title: 'concurrent stop truth',
        summary: 'prove shared stop result',
        workspaceTargetPath: null,
        branchTarget: lane.branch,
        runtime: 'codex',
        dependencyLabels: [],
        dependencyPacketIds: [],
        queueState: 'queued',
        releaseState: 'pending',
        status: 'running',
        blockedReason: null,
        lastEventAt: null,
        lastEventLabel: null,
        archivedAt: null,
        review: null,
        orchestratorThreadId: null,
        lane: {
          tileId: 'tile-stop',
          tabId: 'tab-stop',
          repoPath: process.cwd(),
          runtime: 'codex',
          laneId: lane.id,
          sessionKey,
          lastHeartbeatAt: null,
          lastEventAt: null,
          lastEventLabel: null,
        },
      }],
    });
    h.kill.mockImplementationOnce(() => new Promise((resolve) => {
      finishKill = resolve;
    }));
    const base = { ref: { kind: 'packet', id: packetId }, action: { kind: 'terminate' } } as const;

    const firstPromise = route.POST(post({ ...base, clientMutationId: 'terminate-concurrent-1' }));
    await vi.waitFor(() => expect(h.kill).toHaveBeenCalledTimes(1));
    const secondPromise = route.POST(post({ ...base, clientMutationId: 'terminate-concurrent-2' }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.kill).toHaveBeenCalledTimes(1);
    finishKill([{
      laneId: lane.id,
      sessionKey,
      pid: 123,
      confirmed: false,
      alreadyDead: false,
    }]);

    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    expect(first.status).toBe(409);
    expect(second.status).toBe(409);
    await expect(first.json()).resolves.toMatchObject({
      ok: false,
      result: { status: 'unavailable', reason: 'kill_unconfirmed', aborted: false },
    });
    await expect(second.json()).resolves.toMatchObject({
      ok: false,
      result: { status: 'unavailable', reason: 'kill_unconfirmed', aborted: false },
    });
    expect(h.kill).toHaveBeenCalledTimes(1);
    expect(readOrchestratorControlPlaneState().packets[0]).toMatchObject({
      status: 'blocked',
      queueState: 'held',
      blockedReason: 'kill_unconfirmed',
    });
  });
});
