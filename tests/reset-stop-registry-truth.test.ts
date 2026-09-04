import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';

const h = vi.hoisted(() => ({
  confirmed: false,
  killGate: null as Promise<void> | null,
  killStarted: 0,
  commitsAhead: 1,
  probeGate: null as Promise<void> | null,
  probeStarted: 0,
  archiveConfirmed: true,
  afterSessionArchive: null as (() => void) | null,
  supersedeFailure: false,
  dispatchSideEffectFailure: false,
  dispatchGate: null as Promise<void> | null,
  dispatchStarted: 0,
  dispatchCompleted: 0,
  dispatchReturnWithoutLaunch: false,
  cleanupFailure: false,
  handoffGate: null as Promise<void> | null,
  handoffStarted: 0,
  managedRunStopCalls: [] as string[],
  managedRunConfirmed: 0,
  managedRunFailures: 0,
}));
vi.mock('@/lib/lane/reap-sessions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/lane/reap-sessions')>();
  const archiveResult = (lanes: Array<{ id: string; sessionKey: string | null; runtime: string }>) => {
    const outcomes = lanes.flatMap((lane) => lane.sessionKey?.includes('-owned:') ? [{
      laneId: lane.id,
      sessionKey: lane.sessionKey,
      runtime: lane.runtime,
      archived: h.archiveConfirmed,
      note: h.archiveConfirmed ? 'archived' : 'archive failed',
    }] : []);
    return {
      targeted: outcomes.length,
      archived: outcomes.filter((outcome) => outcome.archived).length,
      outcomes,
      failures: outcomes.filter((outcome) => !outcome.archived),
    };
  };
  return {
    ...actual,
    archiveLaneSessions: vi.fn(async (lanes: Array<{ id: string; sessionKey: string | null; runtime: string }>) => {
      const result = archiveResult(lanes);
      h.afterSessionArchive?.();
      return result;
    }),
    archiveLaneSessionsConfirmed: vi.fn(async (lanes: Array<{ id: string; sessionKey: string | null; runtime: string }>) => {
      const result = archiveResult(lanes);
      h.afterSessionArchive?.();
      actual.assertLaneSessionsArchived(result);
      return result;
    }),
    killLaneSessionsConfirmed: vi.fn(async (lanes: Array<{ id: string; sessionKey: string | null; runtime: string }>) => {
      h.killStarted += 1;
      if (h.killGate) await h.killGate;
      return lanes.flatMap((lane) => lane.sessionKey ? [{
        laneId: lane.id,
        sessionKey: lane.sessionKey,
        runtime: lane.runtime,
        confirmed: h.confirmed,
        alreadyDead: false,
        stages: [],
        note: h.confirmed ? 'confirmed stopped' : 'kill not confirmed',
      }] : []);
    }),
  };
});
vi.mock('@/lib/lane/no-changes-produced', () => ({
  probeNoChangesProduced: vi.fn(async () => {
    h.probeStarted += 1;
    if (h.probeGate) await h.probeGate;
    return { commitsAhead: h.commitsAhead, statusPorcelain: '' };
  }),
}));
vi.mock('@/lib/lane/owned-session-liveness', () => ({
  probeLaneSessionAlive: vi.fn(async () => false),
}));
vi.mock('@/lib/runtimes/managed-runs/packet-lifecycle', () => ({
  terminatePacketManagedRuns: vi.fn(async (packetId: string) => {
    h.managedRunStopCalls.push(packetId);
    return {
      targeted: h.managedRunConfirmed + h.managedRunFailures,
      confirmed: h.managedRunConfirmed,
      failures: Array.from({ length: h.managedRunFailures }, (_, index) => ({
        id: `managed-run-${index}`,
        session: `cortex-run-${index}`,
        reason: 'termination_unconfirmed' as const,
      })),
    };
  }),
}));
vi.mock('@/lib/lane/durable-review-approval', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/lane/durable-review-approval')>();
  return {
    ...actual,
    supersedeDurableApprovedReviews: vi.fn(async (...args: Parameters<typeof actual.supersedeDurableApprovedReviews>) => {
      if (h.supersedeFailure) throw new Error('fixture durable review failure');
      return actual.supersedeDurableApprovedReviews(...args);
    }),
  };
});
vi.mock('@/lib/orchestrator/dispatch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/orchestrator/dispatch')>();
  return {
    ...actual,
    runDispatchTick: vi.fn(async (...args: Parameters<typeof actual.runDispatchTick>) => {
      h.dispatchStarted += 1;
      if (h.dispatchGate) await h.dispatchGate;
      if (h.dispatchReturnWithoutLaunch) {
        h.dispatchCompleted += 1;
        return args[0];
      }
      if (h.dispatchSideEffectFailure) {
        const state = args[0];
        const packet = state.packets.find((candidate) => candidate.status === 'draft' || candidate.status === 'queued');
        if (!packet) throw new Error('fixture could not find dispatchable packet');
        const { createLane, setLaneStatus } = await import('@/lib/lane/registry');
        const lane = createLane({
          repoPath: packet.workspaceTargetPath ?? state.repoPath ?? '/tmp/o8-rerun-side-effect',
          worktreePath: '/tmp/o8-rerun-side-effect-worktree',
          branch: packet.branchTarget,
          runtime: packet.runtime,
          packetId: packet.id,
          sessionKey: 'codex-owned:rerun-side-effect',
        });
        setLaneStatus(lane.id, 'running', 'system', 'fixture_launched');
        throw new Error('fixture dispatch failed after launch side effect');
      }
      return actual.runDispatchTick(...args);
    }),
  };
});
vi.mock('@/lib/orchestrator/operator-mission-service/reset-cleanup', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/orchestrator/operator-mission-service/reset-cleanup')>();
  return {
    ...actual,
    cleanupResetPacketTargets: vi.fn(async (...args: Parameters<typeof actual.cleanupResetPacketTargets>) => {
      if (h.cleanupFailure) throw new Error('fixture worktree cleanup refusal');
      return actual.cleanupResetPacketTargets(...args);
    }),
  };
});
vi.mock('@/lib/orchestrator/mission-registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/orchestrator/mission-registry')>();
  return {
    ...actual,
    persistMissionRegistryStateIfVersion: vi.fn(async (...args: Parameters<typeof actual.persistMissionRegistryStateIfVersion>) => {
      h.handoffStarted += 1;
      if (h.handoffGate) await h.handoffGate;
      return actual.persistMissionRegistryStateIfVersion(...args);
    }),
  };
});

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-reset-stop-registry-truth-'));
const switchRepo = mkdtempSync(join(os.tmpdir(), 'o8-reset-stop-switch-repo-'));
execFileSync('git', ['init', '--initial-branch=main'], { cwd: switchRepo, stdio: 'pipe' });
execFileSync('git', ['-c', 'user.email=test@o8.test', '-c', 'user.name=o8-test', 'commit', '--allow-empty', '-m', 'init'], {
  cwd: switchRepo,
  stdio: 'pipe',
});
const operatorToken = 'operator-reset-stop-registry-0123456789abcdef';
writeFileSync(join(dataDir, 'ws-token'), `${operatorToken}\n`, 'utf8');
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;

const resetRoute = await import('@/app/api/orchestrator/reset-packet/route');
const rerunRoute = await import('@/app/api/orchestrator/rerun-with-feedback/route');
const closeRoute = await import('@/app/api/orchestrator/discard-packet/route');
const controlRoute = await import('@/app/api/agent-control/action/route');
const dispatchRoute = await import('@/app/api/orchestrator/dispatch/route');
const stopMissionRoute = await import('@/app/api/orchestrator/stop-mission/route');
const { closeDb } = await import('@/lib/db');
const { recordMission } = await import('@/lib/db/missions-store');
const { createLane, deleteLane, getLane, setLaneStatus } = await import('@/lib/lane/registry');
const { readMissionRegistryEntry } = await import('@/lib/orchestrator/mission-registry');
const { createMission, resetPacket } = await import('@/lib/orchestrator/operator-mission-service');
const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const {
  readOrchestratorControlPlaneState,
  withLockedState,
  writeOrchestratorControlPlaneState,
} = await import('@/lib/orchestrator/control-plane');

function post(pathname: string, body: unknown) {
  return new NextRequest(`http://localhost:3001${pathname}`, {
    method: 'POST',
    headers: {
      host: 'localhost:3001',
      authorization: `Bearer ${operatorToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

function packetFixture(packetId: string, lane: ReturnType<typeof createLane>) {
  return {
    id: packetId,
    referenceLabel: 'P1',
    title: 'preserve lifecycle truth',
    summary: 'keep bindings until the worker is confirmed stopped',
    workspaceTargetPath: null,
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
    orchestratorThreadId: null,
    lane: {
      tileId: 'tile-reset-truth',
      tabId: 'tab-reset-truth',
      repoPath: lane.repoPath,
      worktreePath: lane.worktreePath,
      runtime: 'codex' as const,
      laneId: lane.id,
      sessionKey: lane.sessionKey,
      lastHeartbeatAt: null,
      lastEventAt: null,
      lastEventLabel: null,
    },
  };
}

function packetWithoutLaneRow(input: {
  packetId: string;
  repoPath: string;
  worktreePath: string;
  branch: string;
  sessionKey: string;
  status?: 'running' | 'awaiting_review';
}) {
  const status = input.status ?? 'running';
  return {
    id: input.packetId,
    referenceLabel: 'P-missing-lane',
    title: 'preserve authoritative packet binding',
    summary: 'the SQLite lane row is missing but the packet still owns a worker',
    workspaceTargetPath: null,
    branchTarget: input.branch,
    runtime: 'codex' as const,
    dependencyLabels: [],
    dependencyPacketIds: [],
    queueState: 'queued' as const,
    releaseState: 'pending' as const,
    status,
    blockedReason: null,
    lastEventAt: null,
    lastEventLabel: null,
    archivedAt: null,
    review: null,
    orchestratorThreadId: null,
    lane: {
      tileId: 'tile-missing-lane',
      tabId: 'tab-missing-lane',
      repoPath: input.repoPath,
      worktreePath: input.worktreePath,
      runtime: 'codex' as const,
      laneId: `lane-missing-${input.packetId}`,
      sessionKey: input.sessionKey,
      lastHeartbeatAt: null,
      lastEventAt: null,
      lastEventLabel: null,
    },
  };
}

function persistRegistryPacket(missionId: string, packet: ReturnType<typeof packetFixture>) {
  const state = {
    ...createEmptyOrchestratorMissionState(),
    missionId,
    repoPath: packet.lane.repoPath,
    packets: [packet],
  };
  recordMission({
    id: missionId,
    repoPath: packet.lane.repoPath ?? '',
    runtime: 'codex',
    prompt: 'registry stop truth',
    summary: 'registry stop truth',
    constraints: '',
    packetMeta: [{ id: packet.id, title: packet.title, referenceLabel: packet.referenceLabel }],
    missionState: state,
    totalWaves: 1,
  });
}

async function createCurrentPacket(label: string) {
  const mission = await createMission({
    issues: [{ number: Date.now(), title: `inline: ${label}`, body: label, url: '' }],
    repoPath: switchRepo,
    runtime: 'codex',
    constraints: '',
  });
  const packetId = mission.packets[0]!.id;
  const lane = createLane({
    repoPath: switchRepo,
    worktreePath: join(switchRepo, `.worktree-${label}`),
    branch: `packet/${label}`,
    runtime: 'codex',
    packetId,
    sessionKey: `codex-owned:${label}`,
  });
  setLaneStatus(lane.id, 'running', 'system', 'test_running');
  await withLockedState((state) => {
    state.packets[0] = packetFixture(packetId, lane);
  });
  return { lane, missionId: mission.missionId, packetId };
}

async function switchCurrentMission(label: string) {
  return createMission({
    issues: [{ number: Date.now() + 1, title: `inline: ${label}`, body: label, url: '' }],
    repoPath: switchRepo,
    runtime: 'codex',
    constraints: '',
  });
}

async function waitForCounter(read: () => number) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (read() > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for lifecycle race seam.');
}

beforeEach(() => {
  h.confirmed = false;
  h.killGate = null;
  h.killStarted = 0;
  h.commitsAhead = 1;
  h.probeGate = null;
  h.probeStarted = 0;
  h.archiveConfirmed = true;
  h.afterSessionArchive = null;
  h.supersedeFailure = false;
  h.dispatchSideEffectFailure = false;
  h.dispatchGate = null;
  h.dispatchStarted = 0;
  h.dispatchCompleted = 0;
  h.dispatchReturnWithoutLaunch = false;
  h.cleanupFailure = false;
  h.handoffGate = null;
  h.handoffStarted = 0;
  h.managedRunStopCalls = [];
  h.managedRunConfirmed = 0;
  h.managedRunFailures = 0;
  writeOrchestratorControlPlaneState({
    ...createEmptyOrchestratorMissionState(),
    missionId: `current-${crypto.randomUUID()}`,
  });
});

afterAll(() => {
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(switchRepo, { recursive: true, force: true });
});

describe('reset and stop preserve runtime truth', () => {
  it('persists async dispatch rearm before returning its accepted receipt', async () => {
    const mission = await switchCurrentMission('async-dispatch-admission');
    await withLockedState((state) => {
      state.packets[0]!.status = 'blocked';
      state.packets[0]!.queueState = 'held';
      state.packets[0]!.blockedReason = 'reset_held';
      state.packets[0]!.operatorStopped = false;
      state.packets[0]!.lane = null;
    });
    let releaseDispatch!: () => void;
    h.dispatchGate = new Promise<void>((resolve) => { releaseDispatch = resolve; });
    h.dispatchReturnWithoutLaunch = true;

    const response = await dispatchRoute.POST(post('/api/orchestrator/dispatch', {
      missionId: mission.missionId,
      wait: false,
      idempotencyKey: 'async-dispatch-admission-1',
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      result: { initiated: true, async: true, missionId: mission.missionId },
    });
    expect(readOrchestratorControlPlaneState().packets[0]).toMatchObject({
      status: 'queued',
      queueState: 'queued',
      blockedReason: null,
    });
    await waitForCounter(() => h.dispatchStarted);
    releaseDispatch();
    await waitForCounter(() => h.dispatchCompleted);
  });

  it('finishes a confirmed stop in the outgoing registry mission after a mission switch', async () => {
    const current = await createCurrentPacket('stop-switch');
    h.confirmed = true;
    let releaseKill!: () => void;
    h.killGate = new Promise<void>((resolve) => { releaseKill = resolve; });

    const stopPromise = controlRoute.POST(post('/api/agent-control/action', {
      ref: { kind: 'packet', id: current.packetId },
      action: { kind: 'terminate' },
      clientMutationId: 'stop-during-mission-switch',
    }));
    await waitForCounter(() => h.killStarted);
    const next = await switchCurrentMission('stop-switch-next');
    releaseKill();

    expect((await stopPromise).status).toBe(200);
    expect(readOrchestratorControlPlaneState().missionId).toBe(next.missionId);
    await vi.waitFor(() => expect(
      readMissionRegistryEntry(current.missionId, { includeArchived: true })?.mission.packets[0],
    ).toMatchObject({ status: 'draft', queueState: 'held', lane: null }));
  });

  it('finishes a reset in the outgoing registry mission after a mission switch', async () => {
    const current = await createCurrentPacket('reset-switch');
    h.confirmed = true;
    let releaseKill!: () => void;
    h.killGate = new Promise<void>((resolve) => { releaseKill = resolve; });

    const resetPromise = resetPacket({ packetId: current.packetId, clearWorktree: true });
    await waitForCounter(() => h.killStarted);
    const next = await switchCurrentMission('reset-switch-next');
    releaseKill();

    await expect(resetPromise).resolves.toMatchObject({ reset: true, salvaged: false });
    expect(readOrchestratorControlPlaneState().missionId).toBe(next.missionId);
    expect(readMissionRegistryEntry(current.missionId, { includeArchived: true })?.mission.packets[0])
      .toMatchObject({ status: 'draft', queueState: 'held', lane: null });
  });

  it('salvages committed retry work in the outgoing registry mission after a mission switch', async () => {
    const current = await createCurrentPacket('salvage-switch');
    h.confirmed = true;
    let releaseKill!: () => void;
    h.killGate = new Promise<void>((resolve) => { releaseKill = resolve; });

    const retryPromise = resetPacket({ packetId: current.packetId, clearWorktree: false });
    await waitForCounter(() => h.killStarted);
    const next = await switchCurrentMission('salvage-switch-next');
    releaseKill();

    await expect(retryPromise).resolves.toMatchObject({ reset: false, salvaged: true });
    expect(readOrchestratorControlPlaneState().missionId).toBe(next.missionId);
    expect(readMissionRegistryEntry(current.missionId, { includeArchived: true })?.mission.packets[0])
      .toMatchObject({ status: 'awaiting_review', blockedReason: null });
  });

  it('continues a retry with no salvage candidate in the outgoing registry mission', async () => {
    const current = await createCurrentPacket('empty-salvage-switch');
    h.confirmed = true;
    h.commitsAhead = 0;
    let releaseProbe!: () => void;
    h.probeGate = new Promise<void>((resolve) => { releaseProbe = resolve; });

    const retryPromise = resetPacket({ packetId: current.packetId, clearWorktree: false });
    await waitForCounter(() => h.probeStarted);
    const next = await switchCurrentMission('empty-salvage-switch-next');
    releaseProbe();

    await expect(retryPromise).resolves.toMatchObject({ reset: true, salvaged: false });
    expect(readOrchestratorControlPlaneState().missionId).toBe(next.missionId);
    expect(readMissionRegistryEntry(current.missionId, { includeArchived: true })?.mission.packets[0])
      .toMatchObject({ status: 'draft', queueState: 'held', lane: null });
  });

  it('waits for the outgoing current mission handoff before mutating its registry packet', async () => {
    const current = await createCurrentPacket('queued-handoff-reset');
    h.confirmed = true;
    const handoffStart = h.handoffStarted;
    let releaseHandoff!: () => void;
    h.handoffGate = new Promise<void>((resolve) => { releaseHandoff = resolve; });

    const switchPromise = switchCurrentMission('queued-handoff-next');
    await vi.waitFor(() => expect(h.handoffStarted).toBeGreaterThan(handoffStart));
    expect(readOrchestratorControlPlaneState().missionId).not.toBe(current.missionId);

    const resetPromise = resetPacket({ packetId: current.packetId, clearWorktree: true });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(h.killStarted).toBe(0);

    releaseHandoff();
    const next = await switchPromise;
    await expect(resetPromise).resolves.toMatchObject({ reset: true, salvaged: false });
    expect(readOrchestratorControlPlaneState().missionId).toBe(next.missionId);
    expect(readMissionRegistryEntry(current.missionId, { includeArchived: true })?.mission.packets[0])
      .toMatchObject({ status: 'draft', queueState: 'held', lane: null });
  });

  it('waits for the outgoing current mission handoff before closing its registry packet', async () => {
    const current = await createCurrentPacket('queued-handoff-close');
    setLaneStatus(current.lane.id, 'reviewing', 'system', 'test_reviewing');
    await withLockedState((state) => {
      state.packets[0]!.status = 'awaiting_review';
      state.packets[0]!.queueState = 'queued';
    });
    const handoffStart = h.handoffStarted;
    let releaseHandoff!: () => void;
    h.handoffGate = new Promise<void>((resolve) => { releaseHandoff = resolve; });

    const switchPromise = switchCurrentMission('queued-handoff-close-next');
    await vi.waitFor(() => expect(h.handoffStarted).toBeGreaterThan(handoffStart));
    expect(readOrchestratorControlPlaneState().missionId).not.toBe(current.missionId);

    const closePromise = closeRoute.POST(post('/api/orchestrator/discard-packet', {
      packetId: current.packetId,
      disposition: 'wontfix',
      clientMutationId: 'close-outgoing-handoff',
    }));
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(h.killStarted).toBe(0);

    releaseHandoff();
    const next = await switchPromise;
    const response = await closePromise;
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { code: 'kill_unconfirmed' },
    });
    expect(readOrchestratorControlPlaneState().missionId).toBe(next.missionId);
    expect(readMissionRegistryEntry(current.missionId, { includeArchived: true })?.mission.packets[0])
      .toMatchObject({ status: 'blocked', queueState: 'held', blockedReason: 'kill_unconfirmed' });
  });

  it('serializes distinct retry and reset requests and rejects the queued destructive intent', async () => {
    const current = await createCurrentPacket('retry-reset-serialization');
    h.confirmed = true;
    let releaseProbe!: () => void;
    h.probeGate = new Promise<void>((resolve) => { releaseProbe = resolve; });

    const retryPromise = resetRoute.POST(post('/api/orchestrator/reset-packet', {
      packetId: current.packetId,
      clearWorktree: false,
      idempotencyKey: 'serialized-retry-first',
    }));
    await waitForCounter(() => h.probeStarted);
    const resetPromise = resetRoute.POST(post('/api/orchestrator/reset-packet', {
      packetId: current.packetId,
      clearWorktree: true,
      idempotencyKey: 'serialized-reset-second',
    }));

    releaseProbe();
    expect((await retryPromise).status).toBe(200);
    const resetResponse = await resetPromise;
    expect(resetResponse.status).toBe(409);
    await expect(resetResponse.json()).resolves.toMatchObject({
      ok: false,
      error: { code: 'reset_state_changed' },
    });
    const packet = readOrchestratorControlPlaneState().packets[0];
    expect(packet).toMatchObject({ status: 'awaiting_review', blockedReason: null });
    expect(packet?.lane?.worktreePath).toBe(current.lane.worktreePath);
    expect(getLane(packet!.lane!.laneId!)).toMatchObject({ status: 'reviewing', worktreePath: current.lane.worktreePath });
  });

  it('serializes stop against a distinct reset and lets only the stop generation clean up', async () => {
    const current = await createCurrentPacket('stop-reset-serialization');
    h.confirmed = true;
    let releaseKill!: () => void;
    h.killGate = new Promise<void>((resolve) => { releaseKill = resolve; });

    const stopPromise = controlRoute.POST(post('/api/agent-control/action', {
      ref: { kind: 'packet', id: current.packetId },
      action: { kind: 'terminate' },
      clientMutationId: 'serialized-stop-first',
    }));
    await waitForCounter(() => h.killStarted);
    const resetPromise = resetRoute.POST(post('/api/orchestrator/reset-packet', {
      packetId: current.packetId,
      clearWorktree: true,
      idempotencyKey: 'serialized-reset-behind-stop',
    }));

    releaseKill();
    expect((await stopPromise).status).toBe(200);
    const resetResponse = await resetPromise;
    expect(resetResponse.status).toBe(409);
    await expect(resetResponse.json()).resolves.toMatchObject({
      ok: false,
      error: { code: 'reset_state_changed' },
    });
    await vi.waitFor(() => expect(getLane(current.lane.id)?.status).toBe('archived'));
    await vi.waitFor(() => expect(readOrchestratorControlPlaneState().packets[0]).toMatchObject({
      status: 'blocked',
      queueState: 'held',
      lane: null,
    }), { timeout: 10_000 });
    expect(h.killStarted).toBe(2);
  });

  it('settles packet-managed runs after the worker dies and before cleanup', async () => {
    const current = await createCurrentPacket('stop-managed-runs');
    h.confirmed = true;
    h.managedRunConfirmed = 1;

    const response = await controlRoute.POST(post('/api/agent-control/action', {
      ref: { kind: 'packet', id: current.packetId },
      action: { kind: 'terminate' },
      clientMutationId: 'stop-managed-runs',
    }));

    expect(response.status).toBe(200);
    expect(h.managedRunStopCalls).toEqual([current.packetId]);
    await vi.waitFor(() => expect(getLane(current.lane.id)?.status).toBe('archived'));
  });

  it('keeps the packet held when a packet-managed run cannot be confirmed dead', async () => {
    const current = await createCurrentPacket('stop-managed-run-unconfirmed');
    h.confirmed = true;
    h.managedRunFailures = 1;

    const response = await controlRoute.POST(post('/api/agent-control/action', {
      ref: { kind: 'packet', id: current.packetId },
      action: { kind: 'terminate' },
      clientMutationId: 'stop-managed-run-unconfirmed',
    }));

    expect(response.status).toBe(409);
    expect(h.managedRunStopCalls).toEqual([current.packetId]);
    expect(readOrchestratorControlPlaneState().packets[0]).toMatchObject({
      status: 'blocked',
      queueState: 'held',
      blockedReason: 'kill_unconfirmed',
      lane: { laneId: current.lane.id, worktreePath: current.lane.worktreePath },
    });
    expect(getLane(current.lane.id)).toMatchObject({
      status: 'running',
      packetId: current.packetId,
      worktreePath: current.lane.worktreePath,
    });
  });

  it('refuses reset when kill is unconfirmed and preserves current packet bindings', async () => {
    const packetId = 'packet-reset-kill-unconfirmed';
    const lane = createLane({
      repoPath: '/tmp/o8-reset-kill-unconfirmed',
      worktreePath: '/tmp/o8-reset-kill-unconfirmed-worktree',
      branch: 'packet/reset-kill-unconfirmed',
      runtime: 'codex',
      packetId,
      sessionKey: 'codex-owned:reset-kill-unconfirmed',
    });
    setLaneStatus(lane.id, 'running', 'system', 'test_running');
    writeOrchestratorControlPlaneState({
      ...createEmptyOrchestratorMissionState(),
      missionId: 'mission-reset-kill-unconfirmed',
      repoPath: lane.repoPath,
      packets: [packetFixture(packetId, lane)],
    });

    const response = await resetRoute.POST(post('/api/orchestrator/reset-packet', {
      packetId,
      clearWorktree: true,
      idempotencyKey: 'reset-kill-unconfirmed',
    }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { code: 'kill_unconfirmed' },
    });
    expect(getLane(lane.id)).toMatchObject({
      status: 'running',
      packetId,
      sessionKey: lane.sessionKey,
      worktreePath: lane.worktreePath,
    });
    const { readOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
    expect(readOrchestratorControlPlaneState().packets[0]).toMatchObject({
      status: 'blocked',
      queueState: 'held',
      blockedReason: 'kill_unconfirmed',
      lane: { laneId: lane.id, sessionKey: lane.sessionKey, worktreePath: lane.worktreePath },
    });
  });

  it('refuses reset when owned-session archival is unconfirmed and preserves bindings', async () => {
    const current = await createCurrentPacket('archive-unconfirmed');
    h.confirmed = true;
    h.archiveConfirmed = false;

    const response = await resetRoute.POST(post('/api/orchestrator/reset-packet', {
      packetId: current.packetId,
      clearWorktree: true,
      idempotencyKey: 'archive-unconfirmed-reset',
    }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { code: 'session_archive_unconfirmed' },
    });
    expect(readOrchestratorControlPlaneState().packets[0]).toMatchObject({
      status: 'blocked',
      queueState: 'held',
      blockedReason: 'session_archive_unconfirmed',
      lane: { laneId: current.lane.id, sessionKey: current.lane.sessionKey, worktreePath: current.lane.worktreePath },
    });
    expect(getLane(current.lane.id)).toMatchObject({
      status: 'running',
      packetId: current.packetId,
      sessionKey: current.lane.sessionKey,
      worktreePath: current.lane.worktreePath,
    });
  });

  it('returns a partial failure and keeps the packet held when hard-reset worktree cleanup fails', async () => {
    const current = await createCurrentPacket('cleanup-failed');
    h.confirmed = true;
    h.cleanupFailure = true;
    const body = {
      packetId: current.packetId,
      clearWorktree: true,
      idempotencyKey: 'cleanup-failed-reset',
    };

    const response = await resetRoute.POST(post('/api/orchestrator/reset-packet', body));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { code: 'worktree_cleanup_failed' },
      result: {
        reset: false,
        partial: true,
        packetId: current.packetId,
        worktreePruned: false,
      },
    });
    const killsAfterFailure = h.killStarted;
    const replay = await resetRoute.POST(post('/api/orchestrator/reset-packet', body));
    expect(replay.status).toBe(409);
    expect(replay.headers.get('x-o8-idempotency-replayed')).toBe('1');
    await expect(replay.json()).resolves.toMatchObject({
      ok: false,
      error: { code: 'worktree_cleanup_failed' },
      result: { partial: true, packetId: current.packetId },
    });
    expect(h.killStarted).toBe(killsAfterFailure);
    expect(readOrchestratorControlPlaneState().packets[0]).toMatchObject({
      status: 'blocked',
      queueState: 'held',
      blockedReason: 'worktree_cleanup_failed',
      lane: { laneId: current.lane.id, worktreePath: current.lane.worktreePath },
    });
  });

  it('returns structured kill-unconfirmed truth through shared packet reset control', async () => {
    const packetId = 'packet-control-reset-kill-unconfirmed';
    const lane = createLane({
      repoPath: '/tmp/o8-control-reset-kill-unconfirmed',
      worktreePath: '/tmp/o8-control-reset-kill-unconfirmed-worktree',
      branch: 'packet/control-reset-kill-unconfirmed',
      runtime: 'codex',
      packetId,
      sessionKey: 'codex-owned:control-reset-kill-unconfirmed',
    });
    setLaneStatus(lane.id, 'running', 'system', 'test_running');
    writeOrchestratorControlPlaneState({
      ...createEmptyOrchestratorMissionState(),
      missionId: 'mission-control-reset-kill-unconfirmed',
      repoPath: lane.repoPath,
      packets: [packetFixture(packetId, lane)],
    });

    const response = await controlRoute.POST(post('/api/agent-control/action', {
      ref: { kind: 'packet', id: packetId },
      action: { kind: 'reset', reason: 'verify shared reset lifecycle truth' },
      clientMutationId: 'control-reset-kill-unconfirmed',
    }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { code: 'kill_unconfirmed' },
      result: {
        status: 'unavailable',
        reason: 'kill_unconfirmed',
        retryable: true,
      },
    });
    const { readOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
    expect(readOrchestratorControlPlaneState().packets[0]).toMatchObject({
      status: 'blocked',
      queueState: 'held',
      operatorStopped: true,
      blockedReason: 'kill_unconfirmed',
      lane: { laneId: lane.id, sessionKey: lane.sessionKey, worktreePath: lane.worktreePath },
    });
    expect(getLane(lane.id)).toMatchObject({
      status: 'running',
      packetId,
      sessionKey: lane.sessionKey,
      worktreePath: lane.worktreePath,
    });
  });

  it('replaces a retry-salvage pending hold with durable kill-unconfirmed truth', async () => {
    const packetId = 'packet-retry-salvage-kill-unconfirmed';
    const lane = createLane({
      repoPath: '/tmp/o8-retry-salvage-kill-unconfirmed',
      worktreePath: '/tmp/o8-retry-salvage-kill-unconfirmed-worktree',
      branch: 'packet/retry-salvage-kill-unconfirmed',
      runtime: 'codex',
      packetId,
      sessionKey: 'codex-owned:retry-salvage-kill-unconfirmed',
    });
    setLaneStatus(lane.id, 'running', 'system', 'test_running');
    writeOrchestratorControlPlaneState({
      ...createEmptyOrchestratorMissionState(),
      missionId: 'mission-retry-salvage-kill-unconfirmed',
      repoPath: lane.repoPath,
      packets: [packetFixture(packetId, lane)],
    });

    const response = await resetRoute.POST(post('/api/orchestrator/reset-packet', {
      packetId,
      clearWorktree: false,
      idempotencyKey: 'retry-salvage-kill-unconfirmed',
    }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { code: 'kill_unconfirmed' },
    });
    const { readOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
    expect(readOrchestratorControlPlaneState().packets[0]).toMatchObject({
      status: 'blocked',
      queueState: 'held',
      operatorStopped: true,
      blockedReason: 'kill_unconfirmed',
      lane: { laneId: lane.id, sessionKey: lane.sessionKey, worktreePath: lane.worktreePath },
    });
    expect(readOrchestratorControlPlaneState().packets[0]?.releaseStatePayload?.source)
      .toMatch(/^retry_salvage:/);
    expect(getLane(lane.id)).toMatchObject({
      status: 'running',
      packetId,
      sessionKey: lane.sessionKey,
      worktreePath: lane.worktreePath,
    });
  });

  it('parks an unconfirmed terminate in its non-current registry mission', async () => {
    const packetId = 'packet-registry-kill-unconfirmed';
    const missionId = 'mission-registry-kill-unconfirmed';
    const lane = createLane({
      repoPath: '/tmp/o8-registry-kill-unconfirmed',
      worktreePath: '/tmp/o8-registry-kill-unconfirmed-worktree',
      branch: 'packet/registry-kill-unconfirmed',
      runtime: 'codex',
      packetId,
      sessionKey: 'codex-owned:registry-kill-unconfirmed',
    });
    setLaneStatus(lane.id, 'running', 'system', 'test_running');
    persistRegistryPacket(missionId, packetFixture(packetId, lane));

    const response = await controlRoute.POST(post('/api/agent-control/action', {
      ref: { kind: 'packet', id: packetId },
      action: { kind: 'terminate' },
      clientMutationId: 'registry-kill-unconfirmed',
    }));

    expect(response.status).toBe(409);
    expect(readMissionRegistryEntry(missionId, { includeArchived: true })?.mission.packets[0]).toMatchObject({
      status: 'blocked',
      queueState: 'held',
      blockedReason: 'kill_unconfirmed',
      lane: { laneId: lane.id, sessionKey: lane.sessionKey },
    });
    expect(getLane(lane.id)).toMatchObject({ status: 'running', packetId, worktreePath: lane.worktreePath });
  });

  it('persists a generation-bound stop hold before kill and blocks concurrent dispatch', async () => {
    const packetId = 'packet-stop-kill-window';
    const missionId = 'mission-stop-kill-window';
    const lane = createLane({
      repoPath: '/tmp/o8-stop-kill-window',
      worktreePath: '/tmp/o8-stop-kill-window-worktree',
      branch: 'packet/stop-kill-window',
      runtime: 'codex',
      packetId,
      sessionKey: 'codex-owned:stop-kill-window',
    });
    setLaneStatus(lane.id, 'running', 'system', 'test_running');
    writeOrchestratorControlPlaneState({
      ...createEmptyOrchestratorMissionState(),
      missionId,
      repoPath: lane.repoPath,
      packets: [packetFixture(packetId, lane)],
    });

    let releaseKill!: () => void;
    h.killGate = new Promise<void>((resolve) => { releaseKill = resolve; });
    const stopResponsePromise = controlRoute.POST(post('/api/agent-control/action', {
      ref: { kind: 'packet', id: packetId },
      action: { kind: 'terminate' },
      clientMutationId: 'stop-kill-window',
    }));

    await vi.waitFor(() => expect(readOrchestratorControlPlaneState().packets[0]).toMatchObject({
      status: 'blocked',
      queueState: 'held',
      operatorStopped: true,
      blockedReason: 'stop_in_progress',
      lane: { laneId: lane.id, sessionKey: lane.sessionKey, worktreePath: lane.worktreePath },
    }));
    expect(readOrchestratorControlPlaneState().packets[0]?.releaseStatePayload?.source)
      .toMatch(/^operator_stop:/);

    const dispatchResponse = await dispatchRoute.POST(post('/api/orchestrator/dispatch', {
      missionId,
      wait: true,
    }));
    expect(dispatchResponse.status).toBe(200);
    await expect(dispatchResponse.json()).resolves.toMatchObject({
      ok: true,
      result: {
        dispatched: 0,
        skipped: [expect.objectContaining({ packetId, reason: 'operator-stopped' })],
      },
    });
    expect(getLane(lane.id)).toMatchObject({
      status: 'running',
      packetId,
      sessionKey: lane.sessionKey,
      worktreePath: lane.worktreePath,
    });

    releaseKill();
    const stopResponse = await stopResponsePromise;
    expect(stopResponse.status).toBe(409);
    await expect(stopResponse.json()).resolves.toMatchObject({
      ok: false,
      result: { reason: 'kill_unconfirmed', aborted: false },
    });
    expect(readOrchestratorControlPlaneState().packets[0]).toMatchObject({
      status: 'blocked',
      queueState: 'held',
      operatorStopped: true,
      blockedReason: 'kill_unconfirmed',
      lane: { laneId: lane.id, sessionKey: lane.sessionKey, worktreePath: lane.worktreePath },
    });
    expect(getLane(lane.id)).toMatchObject({
      status: 'running',
      packetId,
      sessionKey: lane.sessionKey,
      worktreePath: lane.worktreePath,
    });
  });

  it('reset targets the authoritative current packet binding when its lane row is missing', async () => {
    const packetId = 'packet-reset-missing-lane-row';
    const packet = packetWithoutLaneRow({
      packetId,
      repoPath: '/tmp/o8-reset-missing-lane-row',
      worktreePath: '/tmp/o8-reset-missing-lane-row-worktree',
      branch: 'packet/reset-missing-lane-row',
      sessionKey: 'codex-owned:reset-missing-lane-row',
    }) as OrchestratorPacket & { lane: NonNullable<OrchestratorPacket['lane']> };
    writeOrchestratorControlPlaneState({
      ...createEmptyOrchestratorMissionState(),
      missionId: 'mission-reset-missing-lane-row',
      repoPath: packet.lane.repoPath,
      packets: [packet],
    });

    const response = await resetRoute.POST(post('/api/orchestrator/reset-packet', {
      packetId,
      clearWorktree: true,
      idempotencyKey: 'reset-missing-lane-row',
    }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { code: 'kill_unconfirmed' },
    });
    expect(readOrchestratorControlPlaneState().packets[0]).toMatchObject({
      status: 'blocked',
      blockedReason: 'kill_unconfirmed',
      lane: {
        laneId: packet.lane.laneId,
        sessionKey: packet.lane.sessionKey,
        worktreePath: packet.lane.worktreePath,
      },
    });
  });

  it('stop targets a non-current registry packet binding when its lane row is missing', async () => {
    const packetId = 'packet-stop-registry-missing-lane-row';
    const missionId = 'mission-stop-registry-missing-lane-row';
    const packet = packetWithoutLaneRow({
      packetId,
      repoPath: '/tmp/o8-stop-registry-missing-lane-row',
      worktreePath: '/tmp/o8-stop-registry-missing-lane-row-worktree',
      branch: 'packet/stop-registry-missing-lane-row',
      sessionKey: 'codex-owned:stop-registry-missing-lane-row',
    });
    persistRegistryPacket(missionId, packet as ReturnType<typeof packetFixture>);

    const response = await controlRoute.POST(post('/api/agent-control/action', {
      ref: { kind: 'packet', id: packetId },
      action: { kind: 'terminate' },
      clientMutationId: 'stop-registry-missing-lane-row',
    }));

    expect(response.status).toBe(409);
    expect(readMissionRegistryEntry(missionId, { includeArchived: true })?.mission.packets[0]).toMatchObject({
      status: 'blocked',
      blockedReason: 'kill_unconfirmed',
      lane: {
        laneId: packet.lane.laneId,
        sessionKey: packet.lane.sessionKey,
        worktreePath: packet.lane.worktreePath,
      },
    });
  });

  it('mission stop targets a packet-owned session even when its lane id is null', async () => {
    const packetId = 'packet-mission-stop-null-lane-id';
    const packet = packetWithoutLaneRow({
      packetId,
      repoPath: '/tmp/o8-mission-stop-null-lane-id',
      worktreePath: '/tmp/o8-mission-stop-null-lane-id-worktree',
      branch: 'packet/mission-stop-null-lane-id',
      sessionKey: 'codex-owned:mission-stop-null-lane-id',
    }) as OrchestratorPacket & { lane: NonNullable<OrchestratorPacket['lane']> };
    packet.lane.laneId = null;
    writeOrchestratorControlPlaneState({
      ...createEmptyOrchestratorMissionState(),
      missionId: 'mission-stop-null-lane-id',
      repoPath: packet.lane.repoPath,
      packets: [packet],
    });
    const response = await stopMissionRoute.POST(post('/api/orchestrator/stop-mission', {
      missionId: 'mission-stop-null-lane-id',
      idempotencyKey: 'mission-stop-null-lane-id',
    }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: {
        code: 'mission_stop_incomplete',
        message: 'Mission stop was incomplete: 1 packet could not be stopped.',
      },
      result: expect.objectContaining({
        missionId: 'mission-stop-null-lane-id',
        packets: [expect.objectContaining({
          packetId,
          status: 'stop-failed',
        })],
      }),
    });
    expect(h.killStarted).toBe(1);
    expect(readOrchestratorControlPlaneState().packets[0]).toMatchObject({
      status: 'blocked',
      queueState: 'held',
      blockedReason: 'kill_unconfirmed',
      lane: { laneId: null, sessionKey: packet.lane.sessionKey },
    });
  });

  it('mission stop blocks comparison fan-out and launch before stopping its packet snapshot', async () => {
    const packetId = 'packet-mission-stop-admission-race';
    const missionId = 'mission-stop-admission-race';
    const packet = packetWithoutLaneRow({
      packetId,
      repoPath: '/tmp/o8-mission-stop-admission-race',
      worktreePath: '/tmp/o8-mission-stop-admission-race-worktree',
      branch: 'packet/mission-stop-admission-race',
      sessionKey: 'codex-owned:mission-stop-admission-race',
    }) as OrchestratorPacket & { lane: NonNullable<OrchestratorPacket['lane']> };
    packet.comparisonModels = ['model-a', 'model-b'];
    packet.status = 'blocked';
    packet.queueState = 'held';
    packet.operatorStopped = true;
    packet.blockedReason = 'operator_stopped';
    writeOrchestratorControlPlaneState({
      ...createEmptyOrchestratorMissionState(),
      missionId,
      repoPath: packet.lane.repoPath,
      packets: [packet],
    });
    let releaseKill!: () => void;
    h.killGate = new Promise<void>((resolve) => { releaseKill = resolve; });
    const { stopMission } = await import('@/lib/orchestrator/mission-stop');

    const stopPromise = stopMission(missionId);
    await vi.waitFor(() => expect(readOrchestratorControlPlaneState().lifecycleHold).toMatchObject({
      reason: 'operator_stop',
    }));
    const dispatchResponse = await dispatchRoute.POST(post('/api/orchestrator/dispatch', {
      missionId,
      wait: true,
    }));

    expect(dispatchResponse.status).toBe(200);
    await expect(dispatchResponse.json()).resolves.toMatchObject({
      ok: true,
      result: { dispatched: 0 },
    });
    expect(readOrchestratorControlPlaneState().packets.map((candidate) => candidate.id)).toEqual([packetId]);
    expect(readOrchestratorControlPlaneState().packets[0]).toMatchObject({
      queueState: 'held',
      operatorStopped: true,
    });
    expect((await import('@/lib/lane/registry')).listLanes()
      .filter((lane) => lane.packetId === packetId || lane.packetId?.startsWith(`${packetId}-cmp-`)))
      .toEqual([]);

    releaseKill();
    await expect(stopPromise).resolves.toMatchObject({
      packets: [expect.objectContaining({ packetId, status: 'stop-failed' })],
    });
    expect(readOrchestratorControlPlaneState()).toMatchObject({
      lifecycleHold: null,
      packets: [expect.objectContaining({
        id: packetId,
        status: 'blocked',
        blockedReason: 'kill_unconfirmed',
      })],
    });
  });

  it('non-current mission stop blocks registry comparison fan-out and launch', async () => {
    const packetId = 'packet-registry-mission-stop-admission-race';
    const missionId = 'mission-registry-stop-admission-race';
    const packet = packetWithoutLaneRow({
      packetId,
      repoPath: '/tmp/o8-registry-mission-stop-admission-race',
      worktreePath: '/tmp/o8-registry-mission-stop-admission-race-worktree',
      branch: 'packet/registry-mission-stop-admission-race',
      sessionKey: 'codex-owned:registry-mission-stop-admission-race',
    }) as OrchestratorPacket & { lane: NonNullable<OrchestratorPacket['lane']> };
    packet.comparisonModels = ['model-a', 'model-b'];
    persistRegistryPacket(missionId, packet as ReturnType<typeof packetFixture>);
    let releaseKill!: () => void;
    h.killGate = new Promise<void>((resolve) => { releaseKill = resolve; });
    const { stopMission } = await import('@/lib/orchestrator/mission-stop');

    const stopPromise = stopMission(missionId);
    await vi.waitFor(() => expect(
      readMissionRegistryEntry(missionId, { includeArchived: true })?.mission.lifecycleHold,
    ).toMatchObject({ reason: 'operator_stop' }));
    const dispatchResponse = await dispatchRoute.POST(post('/api/orchestrator/dispatch', {
      missionId,
      wait: true,
    }));

    expect(dispatchResponse.status).toBe(200);
    await expect(dispatchResponse.json()).resolves.toMatchObject({
      ok: true,
      result: { dispatched: 0 },
    });
    expect(readMissionRegistryEntry(missionId, { includeArchived: true })?.mission.packets
      .map((candidate) => candidate.id)).toEqual([packetId]);

    releaseKill();
    await expect(stopPromise).resolves.toMatchObject({
      packets: [expect.objectContaining({ packetId, status: 'stop-failed' })],
    });
    expect(readMissionRegistryEntry(missionId, { includeArchived: true })?.mission).toMatchObject({
      lifecycleHold: null,
      packets: [expect.objectContaining({
        id: packetId,
        status: 'blocked',
        blockedReason: 'kill_unconfirmed',
      })],
    });
  });

  it('finalizes an outgoing stopped mission in the registry after the current mission switches', async () => {
    h.confirmed = true;
    const outgoing = await createCurrentPacket('mission-stop-switch-outgoing');
    let releaseKill!: () => void;
    h.killGate = new Promise<void>((resolve) => { releaseKill = resolve; });
    const { stopMission } = await import('@/lib/orchestrator/mission-stop');

    const stopPromise = stopMission(outgoing.missionId);
    await vi.waitFor(() => expect(readOrchestratorControlPlaneState().lifecycleHold).toMatchObject({
      reason: 'operator_stop',
    }));
    await waitForCounter(() => h.killStarted);
    const incoming = await switchCurrentMission('mission-stop-switch-incoming');
    const incomingBeforeFinalize = readOrchestratorControlPlaneState();

    releaseKill();
    await expect(stopPromise).resolves.toMatchObject({
      missionId: outgoing.missionId,
      packets: [expect.objectContaining({ packetId: outgoing.packetId, status: 'stopped' })],
    });

    expect(readOrchestratorControlPlaneState()).toMatchObject({
      missionId: incoming.missionId,
      lifecycleHold: null,
      packets: [{ id: incomingBeforeFinalize.packets[0]?.id }],
    });
    expect(readOrchestratorControlPlaneState().packets[0]?.operatorStopped).not.toBe(true);
    expect(readMissionRegistryEntry(outgoing.missionId, { includeArchived: true })?.mission).toMatchObject({
      missionId: outgoing.missionId,
      lifecycleHold: null,
      packets: [{
        id: outgoing.packetId,
        status: 'blocked',
        queueState: 'held',
        operatorStopped: true,
        blockedReason: 'operator_stopped',
      }],
    });
  });

  it('clears a persisted admission hold owned by a prior server process on dispatch', async () => {
    const mission = await switchCurrentMission('mission-stop-abandoned-hold');
    await withLockedState((state) => {
      state.lifecycleHold = {
        source: 'mission_stop:prior-process',
        reason: 'operator_stop',
        startedAt: new Date(Date.now() - 60_000).toISOString(),
        ownerPid: process.pid + 1,
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      };
      state.packets[0]!.status = 'archived';
      state.packets[0]!.releaseState = 'released';
      state.packets[0]!.archivedAt = new Date().toISOString();
    });

    const response = await dispatchRoute.POST(post('/api/orchestrator/dispatch', {
      missionId: mission.missionId,
      wait: true,
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      result: { dispatched: 0 },
    });
    expect(readOrchestratorControlPlaneState()).toMatchObject({
      missionId: mission.missionId,
      lifecycleHold: null,
    });
  });

  it('rerun holds the packet before kill so concurrent dispatch cannot bind a replacement', async () => {
    const packetId = 'packet-rerun-kill-window';
    const missionId = 'mission-rerun-kill-window';
    const packet = packetWithoutLaneRow({
      packetId,
      repoPath: '/tmp/o8-rerun-kill-window',
      worktreePath: '/tmp/o8-rerun-kill-window-worktree',
      branch: 'packet/rerun-kill-window',
      sessionKey: 'codex-owned:rerun-kill-window',
      status: 'awaiting_review',
    });
    writeOrchestratorControlPlaneState({
      ...createEmptyOrchestratorMissionState(),
      missionId,
      repoPath: packet.lane.repoPath,
      packets: [packet],
    });
    let releaseKill!: () => void;
    h.killGate = new Promise<void>((resolve) => { releaseKill = resolve; });

    const rerunPromise = rerunRoute.POST(post('/api/orchestrator/rerun-with-feedback', {
      packetId,
      feedback: 'try the fix again',
      idempotencyKey: 'rerun-kill-window',
    }));
    await vi.waitFor(() => expect(readOrchestratorControlPlaneState().packets[0]).toMatchObject({
      status: 'blocked',
      queueState: 'held',
      blockedReason: 'rerun_in_progress',
      lane: { sessionKey: packet.lane.sessionKey },
    }));

    const dispatchResponse = await dispatchRoute.POST(post('/api/orchestrator/dispatch', { missionId, wait: true }));
    expect(dispatchResponse.status).toBe(200);
    await expect(dispatchResponse.json()).resolves.toMatchObject({
      ok: true,
      result: { dispatched: 0 },
    });
    releaseKill();
    const response = await rerunPromise;
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { code: 'kill_unconfirmed' },
    });
    expect(readOrchestratorControlPlaneState().packets[0]).toMatchObject({
      status: 'blocked',
      blockedReason: 'kill_unconfirmed',
      lane: { sessionKey: packet.lane.sessionKey, worktreePath: packet.lane.worktreePath },
    });
  });

  it('rerun preserves an unconfirmed non-current registry binding without a lane row', async () => {
    const packetId = 'packet-rerun-registry-missing-lane-row';
    const missionId = 'mission-rerun-registry-missing-lane-row';
    const packet = packetWithoutLaneRow({
      packetId,
      repoPath: '/tmp/o8-rerun-registry-missing-lane-row',
      worktreePath: '/tmp/o8-rerun-registry-missing-lane-row-worktree',
      branch: 'packet/rerun-registry-missing-lane-row',
      sessionKey: 'codex-owned:rerun-registry-missing-lane-row',
      status: 'awaiting_review',
    });
    persistRegistryPacket(missionId, packet as ReturnType<typeof packetFixture>);

    const response = await rerunRoute.POST(post('/api/orchestrator/rerun-with-feedback', {
      packetId,
      feedback: 'retry without losing the owned worker',
      idempotencyKey: 'rerun-registry-missing-lane-row',
    }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { code: 'kill_unconfirmed' },
    });
    expect(readMissionRegistryEntry(missionId, { includeArchived: true })?.mission.packets[0]).toMatchObject({
      status: 'blocked',
      queueState: 'held',
      blockedReason: 'kill_unconfirmed',
      lane: { sessionKey: packet.lane.sessionKey, worktreePath: packet.lane.worktreePath },
    });
  });

  it('records a durable rerun failure after the old generation is retired', async () => {
    const current = await createCurrentPacket('rerun-post-retirement-failure');
    h.confirmed = true;
    h.supersedeFailure = true;
    const body = {
      packetId: current.packetId,
      feedback: 'retry after review',
      idempotencyKey: 'rerun-post-retirement-failure',
    };

    const response = await rerunRoute.POST(post('/api/orchestrator/rerun-with-feedback', body));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'rerun_failed',
        message: expect.stringContaining('no replacement worker'),
      },
    });
    const killsAfterFailure = h.killStarted;
    const replay = await rerunRoute.POST(post('/api/orchestrator/rerun-with-feedback', body));
    expect(replay.status).toBe(409);
    expect(replay.headers.get('x-o8-idempotency-replayed')).toBe('1');
    await expect(replay.json()).resolves.toMatchObject({
      ok: false,
      error: { code: 'rerun_failed', message: expect.stringContaining('no replacement worker') },
    });
    expect(h.killStarted).toBe(killsAfterFailure);
    expect(getLane(current.lane.id)).toMatchObject({ status: 'archived', packetId: '' });
    expect(readOrchestratorControlPlaneState().packets[0]).toMatchObject({
      status: 'blocked',
      queueState: 'held',
      blockedReason: 'rerun_failed',
      lane: null,
    });
  });

  it('confirmed-retires a replacement worker when dispatch throws after launch', async () => {
    const current = await createCurrentPacket('rerun-dispatch-side-effect-failure');
    h.confirmed = true;
    h.dispatchSideEffectFailure = true;

    const response = await rerunRoute.POST(post('/api/orchestrator/rerun-with-feedback', {
      packetId: current.packetId,
      feedback: 'retry after review',
      idempotencyKey: 'rerun-dispatch-side-effect-failure',
    }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { code: 'rerun_failed', message: expect.stringContaining('no replacement worker') },
    });
    const packetLanes = (await import('@/lib/lane/registry')).listLanes()
      .filter((lane) => lane.packetId === current.packetId);
    expect(packetLanes).toEqual([]);
    expect(h.killStarted).toBeGreaterThanOrEqual(2);
    expect(readOrchestratorControlPlaneState().packets[0]).toMatchObject({
      status: 'blocked',
      queueState: 'held',
      blockedReason: 'rerun_failed',
      lane: null,
    });
  });

  it('close refuses ambiguous stale and authoritative worktrees without retiring either', async () => {
    const packetId = 'packet-close-binding-drift';
    const repoPath = '/tmp/o8-close-binding-drift';
    const branch = 'packet/close-binding-drift';
    const stale = createLane({
      repoPath,
      worktreePath: '/tmp/o8-close-binding-drift-stale',
      branch,
      runtime: 'codex',
      packetId,
    });
    setLaneStatus(stale.id, 'reviewing', 'system', 'test_reviewing');
    const packet = packetWithoutLaneRow({
      packetId,
      repoPath,
      worktreePath: '/tmp/o8-close-binding-drift-current',
      branch,
      sessionKey: 'codex-owned:close-binding-drift-current',
      status: 'awaiting_review',
    });
    writeOrchestratorControlPlaneState({
      ...createEmptyOrchestratorMissionState(),
      missionId: 'mission-close-binding-drift',
      repoPath,
      packets: [packet],
    });

    const response = await closeRoute.POST(post('/api/orchestrator/discard-packet', {
      packetId,
      disposition: 'wontfix',
      clientMutationId: 'close-binding-drift',
    }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { code: 'ambiguous_lifecycle_targets' },
    });
    expect(getLane(stale.id)).toMatchObject({
      status: 'reviewing',
      packetId,
      worktreePath: stale.worktreePath,
    });
    expect(readOrchestratorControlPlaneState().packets[0]).toMatchObject({
      status: 'awaiting_review',
      blockedReason: null,
      lane: { sessionKey: packet.lane.sessionKey, worktreePath: packet.lane.worktreePath },
    });
  });

  it('close holds the generation before kill so concurrent dispatch cannot bind a worker', async () => {
    const packetId = 'packet-close-kill-window';
    const missionId = 'mission-close-kill-window';
    const packet = packetWithoutLaneRow({
      packetId,
      repoPath: '/tmp/o8-close-kill-window',
      worktreePath: '/tmp/o8-close-kill-window-worktree',
      branch: 'packet/close-kill-window',
      sessionKey: 'codex-owned:close-kill-window',
      status: 'awaiting_review',
    });
    writeOrchestratorControlPlaneState({
      ...createEmptyOrchestratorMissionState(),
      missionId,
      repoPath: packet.lane.repoPath,
      packets: [packet],
    });
    let releaseKill!: () => void;
    h.killGate = new Promise<void>((resolve) => { releaseKill = resolve; });

    const closePromise = closeRoute.POST(post('/api/orchestrator/discard-packet', {
      packetId,
      disposition: 'wontfix',
      clientMutationId: 'close-kill-window',
    }));
    await vi.waitFor(() => expect(readOrchestratorControlPlaneState().packets[0]).toMatchObject({
      status: 'blocked',
      queueState: 'held',
      blockedReason: 'close_in_progress',
      lane: { sessionKey: packet.lane.sessionKey },
    }));

    const dispatchResponse = await dispatchRoute.POST(post('/api/orchestrator/dispatch', { missionId, wait: true }));
    expect(dispatchResponse.status).toBe(200);
    await expect(dispatchResponse.json()).resolves.toMatchObject({
      ok: true,
      result: { dispatched: 0 },
    });
    releaseKill();
    const response = await closePromise;
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { code: 'kill_unconfirmed' },
    });
    expect(readOrchestratorControlPlaneState().packets[0]).toMatchObject({
      status: 'blocked',
      blockedReason: 'kill_unconfirmed',
      lane: { sessionKey: packet.lane.sessionKey, worktreePath: packet.lane.worktreePath },
    });
  });

  it('keeps a durable failure reason when the persisted lane disappears during close', async () => {
    h.confirmed = true;
    const packetId = 'packet-close-lane-store-failure';
    const repoPath = '/tmp/o8-close-lane-store-failure';
    const lane = createLane({
      repoPath,
      branch: 'packet/close-lane-store-failure',
      runtime: 'codex',
      packetId,
    });
    setLaneStatus(lane.id, 'reviewing', 'system', 'test_reviewing');
    writeOrchestratorControlPlaneState({
      ...createEmptyOrchestratorMissionState(),
      missionId: 'mission-close-lane-store-failure',
      repoPath,
      packets: [{
        ...packetFixture(packetId, lane),
        status: 'awaiting_review',
        queueState: 'queued',
      }],
    });
    h.afterSessionArchive = () => { deleteLane(lane.id); };

    const response = await closeRoute.POST(post('/api/orchestrator/discard-packet', {
      packetId,
      disposition: 'wontfix',
      clientMutationId: 'close-lane-store-failure',
    }));

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { code: 'close_failed', message: 'Lane not found.' },
    });
    expect(getLane(lane.id)).toBeNull();
    expect(readOrchestratorControlPlaneState().packets[0]).toMatchObject({
      status: 'blocked',
      queueState: 'held',
      blockedReason: 'lane_archive_failed',
      lane: { laneId: lane.id },
    });
  });

  it('does not stamp an old scoped kill failure onto a newer packet generation', async () => {
    const packetId = 'packet-stale-scoped-kill';
    const oldGeneration = 'operator_stop:old-generation';
    const newGeneration = 'operator_stop:new-generation';
    const lane = createLane({
      repoPath: '/tmp/o8-stale-scoped-kill',
      worktreePath: '/tmp/o8-stale-scoped-kill-worktree',
      branch: 'packet/stale-scoped-kill',
      runtime: 'codex',
      packetId,
      sessionKey: 'codex-owned:stale-scoped-kill',
    });
    setLaneStatus(lane.id, 'running', 'system', 'test_running');
    writeOrchestratorControlPlaneState({
      ...createEmptyOrchestratorMissionState(),
      missionId: 'mission-stale-scoped-kill',
      repoPath: lane.repoPath,
      packets: [{
        ...packetFixture(packetId, lane),
        status: 'blocked',
        queueState: 'held',
        operatorStopped: true,
        blockedReason: 'stop_in_progress',
        releaseStatePayload: { source: oldGeneration },
      }],
    });

    let releaseKill!: () => void;
    h.killGate = new Promise<void>((resolve) => { releaseKill = resolve; });
    const resetPromise = resetPacket({
      packetId,
      clearWorktree: true,
      scope: {
        laneIds: [lane.id],
        skipHoldIfStateMoved: true,
        expectedReleaseSource: oldGeneration,
      },
    });
    await vi.waitFor(() => expect(h.killStarted).toBe(1));

    await withLockedState((state) => {
      const packet = state.packets.find((candidate) => candidate.id === packetId);
      if (!packet) throw new Error('packet disappeared during test');
      packet.status = 'running';
      packet.queueState = 'queued';
      packet.operatorStopped = false;
      packet.blockedReason = 'new_generation_active';
      packet.releaseStatePayload = { source: newGeneration };
      packet.lastEventLabel = 'new_generation_active';
    });
    releaseKill();

    await expect(resetPromise).rejects.toThrow('could not confirm');
    expect(readOrchestratorControlPlaneState().packets[0]).toMatchObject({
      status: 'running',
      queueState: 'queued',
      releaseStatePayload: { source: newGeneration },
      lane: { laneId: lane.id, sessionKey: lane.sessionKey, worktreePath: lane.worktreePath },
    });
    expect(readOrchestratorControlPlaneState().packets[0]?.blockedReason).not.toBe('kill_unconfirmed');
    expect(getLane(lane.id)).toMatchObject({
      status: 'running',
      packetId,
      sessionKey: lane.sessionKey,
      worktreePath: lane.worktreePath,
    });
  });

  it('carries a confirmed stop generation through non-current registry cleanup', async () => {
    h.confirmed = true;
    const packetId = 'packet-registry-confirmed-stop';
    const missionId = 'mission-registry-confirmed-stop';
    const lane = createLane({
      repoPath: '/tmp/o8-registry-confirmed-stop',
      worktreePath: '/tmp/o8-registry-confirmed-stop-worktree',
      branch: 'packet/registry-confirmed-stop',
      runtime: 'codex',
      packetId,
      sessionKey: 'codex-owned:registry-confirmed-stop',
    });
    setLaneStatus(lane.id, 'running', 'system', 'test_running');
    persistRegistryPacket(missionId, packetFixture(packetId, lane));

    const response = await controlRoute.POST(post('/api/agent-control/action', {
      ref: { kind: 'packet', id: packetId },
      action: { kind: 'terminate' },
      clientMutationId: 'registry-confirmed-stop',
    }));

    expect(response.status).toBe(200);
    await vi.waitFor(() => expect(getLane(lane.id)?.status).toBe('archived'));
    expect(readMissionRegistryEntry(missionId, { includeArchived: true })?.mission.packets[0]).toMatchObject({
      status: 'draft',
      queueState: 'held',
      lane: null,
    });
  });
});
