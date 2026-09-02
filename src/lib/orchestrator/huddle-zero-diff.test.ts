import { describe, expect, it } from 'vitest';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createLane, getLane, setLaneStatus } from '@/lib/lane/registry';
import { writeOrchestratorControlPlaneState } from '@/lib/orchestrator/control-plane';
import { createEmptyOrchestratorMissionState } from '@/lib/orchestrator/store';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';

import { HUDDLE_READY_EVENT_LABEL, parkHuddleReadyZeroDiffLane } from './huddle-zero-diff';

function huddlePacket(
  id: string,
  repoPath: string,
  huddle: boolean | undefined,
  runtime: OrchestratorPacket['runtime'] = 'codex',
): OrchestratorPacket {
  return {
    id,
    referenceLabel: id.toUpperCase(),
    title: `packet ${id}`,
    summary: `packet ${id}`,
    status: 'running',
    queueState: 'queued',
    releaseState: 'pending',
    runtime,
    wave: 1,
    dependencyPacketIds: [],
    dependencyLabels: [],
    blockedReason: null,
    lane: null,
    review: null,
    workspaceTargetPath: repoPath,
    branchTarget: `inline/${id}`,
    ...(typeof huddle === 'boolean' ? { huddle } : {}),
  } as OrchestratorPacket;
}

function seedHuddleLane(packetId: string, huddle: boolean | undefined, runtime: OrchestratorPacket['runtime'] = 'codex') {
  const repoPath = '/tmp/o8-huddle-zero-diff-test-repo';
  const lane = createLane({
    repoPath,
    branch: `inline/${packetId}`,
    baseBranch: 'main',
    runtime: 'codex',
    packetId,
    sessionKey: `codex-owned:${packetId}`,
    worktreePath: `${repoPath}/.cortex-worktrees/packet-${packetId}`,
  });
  // The worker was running its alignment turn.
  setLaneStatus(lane.id, 'running', 'system', 'session_running');

  const state = createEmptyOrchestratorMissionState();
  state.packets = [huddlePacket(packetId, repoPath, huddle, runtime)];
  writeOrchestratorControlPlaneState(state);

  return getLane(lane.id)!;
}

function resolveSeededAlignment(packetId: string) {
  const state = createEmptyOrchestratorMissionState();
  state.packets = [{
    ...huddlePacket(packetId, '/tmp/o8-huddle-zero-diff-test-repo', true),
    alignmentResolvedAt: '2026-09-01T02:00:00.000Z',
  }];
  writeOrchestratorControlPlaneState(state);
}

describe('parkHuddleReadyZeroDiffLane (#1496)', () => {
  it('parks a huddle packet on zero-diff exit WITHOUT any plan/report signal (steer stays reachable)', async () => {
    // No agent_report huddle event and no transcript — the exact #1502/#1496
    // conditions that used to false-fail the alignment turn.
    const lane = seedHuddleLane('pkt-huddle-noplan', true);

    const result = await parkHuddleReadyZeroDiffLane(lane);

    expect(result.parked).toBe(true);
    const after = getLane(lane.id);
    expect(after?.status).toBe('awaiting_orchestrator');
    expect(after?.lastEventLabel).toBe(HUDDLE_READY_EVENT_LABEL);
    // The session key MUST survive so codex `exec resume` (steer_packet) can
    // reach it — the whole point of parking instead of failing.
    expect(after?.sessionKey).toBe('codex-owned:pkt-huddle-noplan');
  });

  it('does NOT park a non-huddle packet (real zero-diff failure still surfaces)', async () => {
    const lane = seedHuddleLane('pkt-plain-nohuddle', false);

    const result = await parkHuddleReadyZeroDiffLane(lane);

    expect(result.parked).toBe(false);
    // Left untouched — the caller falls through to its zero_diff_failed path.
    expect(getLane(lane.id)?.status).toBe('running');
  });

  it('does NOT classify a later zero-diff exit as huddle after alignment was resolved', async () => {
    const lane = seedHuddleLane('pkt-huddle-resolved', true);
    resolveSeededAlignment('pkt-huddle-resolved');

    const result = await parkHuddleReadyZeroDiffLane(lane);

    expect(result.parked).toBe(false);
    expect(result.operatorBlocked).not.toBe(true);
    expect(getLane(lane.id)?.status).toBe('running');
  });

  it('preserves a typed operator blocker instead of relabeling it as huddle-ready', async () => {
    const lane = seedHuddleLane('pkt-huddle-typed-blocker', true);
    resolveSeededAlignment('pkt-huddle-typed-blocker');
    const blocked = setLaneStatus(lane.id, 'awaiting_orchestrator', 'system', 'nondeterministic_test');

    const result = await parkHuddleReadyZeroDiffLane(lane);

    expect(result).toMatchObject({
      parked: false,
      operatorBlocked: true,
      lane: { id: lane.id, status: 'awaiting_orchestrator', lastEventLabel: 'nondeterministic_test' },
    });
    expect(getLane(blocked!.id)?.lastEventLabel).toBe('nondeterministic_test');
  });

  it('parks an adaptive legacy packet without an explicit huddle choice', async () => {
    const prev = process.env.O8_SUBSCRIPTION_PROFILE;
    process.env.O8_SUBSCRIPTION_PROFILE = 'claude-only';
    const defaultsPath = join(process.env.CORTEX_IDE_DATA_DIR!, 'operator-defaults.json');
    writeFileSync(defaultsPath, JSON.stringify({ workerStartMode: 'adaptive' }));
    try {
      const lane = seedHuddleLane('pkt-advisor-nohuddle', undefined, 'claude-code');

      const result = await parkHuddleReadyZeroDiffLane(lane);

      expect(result.parked).toBe(true);
      expect(getLane(lane.id)?.status).toBe('awaiting_orchestrator');
    } finally {
      rmSync(defaultsPath, { force: true });
      if (prev === undefined) delete process.env.O8_SUBSCRIPTION_PROFILE;
      else process.env.O8_SUBSCRIPTION_PROFILE = prev;
    }
  });
});
