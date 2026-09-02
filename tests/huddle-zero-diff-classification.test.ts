import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const performRuntimeActionMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/runtime/actions', () => ({
  performRuntimeAction: performRuntimeActionMock,
}));

process.env.CORTEX_IDE_DATA_DIR = mkdtempSync(join(tmpdir(), 'o8-huddle-zero-diff-data-'));
process.env.O8_DATA_DIR = process.env.CORTEX_IDE_DATA_DIR;

const { dispatch } = await import('@/lib/lane/commands');
const { reportAgentEvent } = await import('@/lib/lane/agent-report');
const { createLane, getLane, listLanes } = await import('@/lib/lane/registry');
const { readOrchestratorControlPlaneState, writeOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
const { buildPacketPrompt } = await import('@/lib/orchestrator/packet-prompt');
const { steerPacket } = await import('@/lib/orchestrator/operator-mission-service/steer');
const { resetPacket } = await import('@/lib/orchestrator/operator-mission-service/reset');
const { getMissionStatus } = await import('@/lib/orchestrator/operator-mission-service');
const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const { readMissionRegistryEntry } = await import('@/lib/orchestrator/mission-registry');
const { HUDDLE_READY_EVENT_LABEL } = await import('@/lib/orchestrator/huddle-zero-diff');
const { HUDDLE_PROMPT_SECTION } = await import('@/lib/orchestrator/huddle-access');
const { getSqlite } = await import('@/lib/db');
import type { OrchestratorPacket } from '@/lib/orchestrator/types';

afterAll(() => {
  rmSync(process.env.CORTEX_IDE_DATA_DIR as string, { recursive: true, force: true });
});

beforeEach(() => {
  performRuntimeActionMock.mockReset();
});

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
}

function makeCleanWorktree(): string {
  const dir = mkdtempSync(join(tmpdir(), 'o8-huddle-zero-diff-wt-'));
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@o8.dev']);
  git(dir, ['config', 'user.name', 'o8 test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(dir, 'base.txt'), 'base\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '--no-verify', '-m', 'base']);
  return dir;
}

function packetFor(packetId: string, worktreePath: string, laneId: string, sessionKey: string): OrchestratorPacket {
  return {
    id: packetId,
    referenceLabel: 'P1',
    title: 'Plan before editing',
    summary: 'Huddle turn should not produce a diff.',
    workspaceTargetPath: worktreePath,
    branchTarget: 'pkt/huddle-zero-diff',
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
      tileId: laneId,
      tabId: laneId,
      repoPath: worktreePath,
      worktreePath,
      runtime: 'codex',
      sessionKey,
      laneId,
      lastHeartbeatAt: null,
      lastEventAt: null,
      lastEventLabel: null,
    },
    huddle: true,
  };
}

describe('huddle zero-diff classification', () => {
  it('parks a huddle-armed lane with a persisted huddle report instead of failing zero-diff', async () => {
    const packetId = 'pkt-huddle-zero-diff';
    const sessionKey = 'codex-owned:huddle-zero-diff';
    const worktreePath = makeCleanWorktree();
    const lane = createLane({
      repoPath: worktreePath,
      worktreePath,
      branch: 'pkt/huddle-zero-diff',
      baseBranch: 'main',
      runtime: 'codex',
      sessionKey,
      packetId,
    });

    writeOrchestratorControlPlaneState({
      ...createEmptyOrchestratorMissionState(),
      missionId: 'mission-huddle-zero-diff',
      repoPath: worktreePath,
      runtime: 'codex',
      packets: [packetFor(packetId, worktreePath, lane.id, sessionKey)],
      updatedAt: new Date().toISOString(),
    });

    const report = reportAgentEvent({
      laneId: lane.id,
      actor: 'system',
      event: 'huddle',
      message: 'Implementation plan: inspect the classifier, patch the chokepoint, add regression coverage.',
    });
    expect(report?.statusChanged).toBe(true);

    const result = await dispatch({
      verb: 'request_review',
      laneId: lane.id,
      actor: 'system',
    });

    expect(result.ok).toBe(false);
    expect(result.note).toBe(HUDDLE_READY_EVENT_LABEL);

    const parkedLane = getLane(lane.id);
    expect(parkedLane?.status).toBe('awaiting_orchestrator');
    expect(parkedLane?.lastEventLabel).toBe(HUDDLE_READY_EVENT_LABEL);

    const packet = readOrchestratorControlPlaneState().packets.find((candidate) => candidate.id === 'pkt-huddle-zero-diff');
    expect(packet?.status).toBe('blocked');
    expect(packet?.blockedReason).toBe(HUDDLE_READY_EVENT_LABEL);
    expect(packet?.lastEventLabel).toBe(HUDDLE_READY_EVENT_LABEL);
    expect(packet?.status).not.toBe('failed');
    expect(listLanes()).toHaveLength(1);
  });

  it('consumes alignment on steer and preserves a later typed blocker through zero-diff completion', async () => {
    const packetId = 'pkt-huddle-consumed-real-path';
    const sessionKey = 'test-runtime:huddle-consumed';
    const missionId = 'mission-huddle-consumed-real-path';
    const worktreePath = makeCleanWorktree();
    const lane = createLane({
      repoPath: worktreePath,
      worktreePath,
      branch: 'pkt/huddle-consumed-real-path',
      baseBranch: 'main',
      runtime: 'codex',
      sessionKey,
      packetId,
    });

    writeOrchestratorControlPlaneState({
      ...createEmptyOrchestratorMissionState(),
      missionId,
      repoPath: worktreePath,
      runtime: 'codex',
      packets: [packetFor(packetId, worktreePath, lane.id, sessionKey)],
      updatedAt: new Date().toISOString(),
    });

    reportAgentEvent({
      laneId: lane.id,
      actor: 'system',
      event: 'huddle',
      message: 'Plan: align once, implement, and preserve a causal blocker if bounded verification fails.',
    });
    await dispatch({ verb: 'request_review', laneId: lane.id, actor: 'system' });

    performRuntimeActionMock.mockResolvedValue({
      ok: true,
      action: 'steer',
      surfaceId: sessionKey,
      sessionKey,
      runtime: 'codex',
      status: 'running',
      note: 'Steered test runtime.',
    });
    await steerPacket({ packetId, message: 'Plan approved. Implement now.' });

    const resolvedPacket = readOrchestratorControlPlaneState().packets
      .find((candidate) => candidate.id === packetId)!;
    expect(resolvedPacket.alignmentResolvedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const freshPrompt = await buildPacketPrompt(resolvedPacket, []);
    expect(freshPrompt).not.toContain(HUDDLE_PROMPT_SECTION);

    reportAgentEvent({
      laneId: lane.id,
      actor: 'system',
      event: 'blocked',
      reason: 'nondeterministic_test',
      message: 'Stopped after the bounded test failed repeatedly; the clean tree is intentional.',
    });
    const completion = await dispatch({ verb: 'request_review', laneId: lane.id, actor: 'system' });

    expect(completion).toMatchObject({ ok: false, note: 'nondeterministic_test' });
    expect(getLane(lane.id)).toMatchObject({
      status: 'awaiting_orchestrator',
      lastEventLabel: 'nondeterministic_test',
    });
    const status = await getMissionStatus({ missionId, includeCost: false });
    expect(status.packets.find((candidate) => candidate.id === packetId)).toMatchObject({
      status: 'blocked',
      blockedReason: 'nondeterministic_test',
      lane: { status: 'awaiting_orchestrator', lastEventLabel: 'nondeterministic_test' },
    });
  });

  it('consumes alignment on reset so the redispatch prompt no longer arms the huddle turn', async () => {
    const packetId = 'pkt-huddle-consumed-on-reset';
    const missionId = 'mission-huddle-consumed-on-reset';
    const worktreePath = makeCleanWorktree();
    // The documented reset recovery: the worker's session is already gone, so
    // the lane carries no session key to kill.
    const lane = createLane({
      repoPath: worktreePath,
      worktreePath,
      branch: 'pkt/huddle-consumed-on-reset',
      baseBranch: 'main',
      runtime: 'codex',
      packetId,
    });

    const armed = packetFor(packetId, worktreePath, lane.id, '');
    armed.lane!.sessionKey = '';
    writeOrchestratorControlPlaneState({
      ...createEmptyOrchestratorMissionState(),
      missionId,
      repoPath: worktreePath,
      runtime: 'codex',
      packets: [armed],
      updatedAt: new Date().toISOString(),
    });

    const armedPacket = readOrchestratorControlPlaneState().packets
      .find((candidate) => candidate.id === packetId)!;
    expect(await buildPacketPrompt(armedPacket, [])).toContain(HUDDLE_PROMPT_SECTION);

    const reset = await resetPacket({ packetId, reason: 'session_lost', clearWorktree: false });
    expect(reset).toMatchObject({ reset: true, packetId });

    const resetPersisted = readOrchestratorControlPlaneState().packets
      .find((candidate) => candidate.id === packetId)!;
    expect(resetPersisted.queueState).toBe('held');
    expect(resetPersisted.alignmentResolvedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const redispatchPrompt = await buildPacketPrompt(resetPersisted, []);
    expect(redispatchPrompt).not.toContain(HUDDLE_PROMPT_SECTION);
  });

  it('persists consumed alignment when a steerable packet lives in the mission registry', async () => {
    const packetId = 'pkt-huddle-registry-consumed';
    const missionId = 'mission-huddle-registry-consumed';
    const sessionKey = 'test-runtime:huddle-registry-consumed';
    const worktreePath = makeCleanWorktree();
    createLane({
      repoPath: worktreePath,
      worktreePath,
      branch: 'pkt/huddle-registry-consumed',
      baseBranch: 'main',
      runtime: 'codex',
      sessionKey,
      packetId,
    });
    const registryState = {
      ...createEmptyOrchestratorMissionState(),
      missionId,
      repoPath: worktreePath,
      runtime: 'codex' as const,
      packets: [packetFor(packetId, worktreePath, 'lane-registry-consumed', sessionKey)],
    };
    const now = Date.now();
    getSqlite().prepare(
      `INSERT INTO missions (
         id, repo_path, runtime, prompt, summary, constraints, packet_meta_json,
         total_waves, created_at, updated_at, archived_at, mission_state_json
       ) VALUES (?, ?, 'codex', '', '', '', '[]', 1, ?, ?, NULL, ?)`,
    ).run(missionId, worktreePath, now, now, JSON.stringify(registryState));
    writeOrchestratorControlPlaneState({
      ...createEmptyOrchestratorMissionState(),
      missionId: 'mission-current-unrelated',
      packets: [],
    });

    performRuntimeActionMock.mockResolvedValue({
      ok: true,
      action: 'steer',
      surfaceId: sessionKey,
      sessionKey,
      runtime: 'codex',
      status: 'running',
      note: 'Steered test runtime.',
    });
    await steerPacket({ packetId, message: 'Plan approved. Implement now.' });

    const persisted = readMissionRegistryEntry(missionId, { includeArchived: true })
      ?.mission.packets.find((candidate) => candidate.id === packetId);
    expect(persisted?.alignmentResolvedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(persisted?.huddle).toBe(true);
  });
});
