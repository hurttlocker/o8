import { describe, expect, it } from 'vitest';
import { aggregateMissionCost, runtimeFromSessionKey, type LaneSessionInfo } from './cost-aggregator';
import type { OrchestratorMissionState, OrchestratorPacket } from './types';

function stubPacket(overrides: Partial<OrchestratorPacket>): OrchestratorPacket {
  return {
    id: 'packet-cost',
    referenceLabel: 'PKT-COST',
    title: 'cost receipt',
    summary: 'cost receipt',
    workspaceTargetPath: null,
    branchTarget: '',
    runtime: 'codex',
    dependencyLabels: [],
    dependencyPacketIds: [],
    queueState: 'queued',
    releaseState: 'pending',
    status: 'queued',
    lane: null,
    ...overrides,
  };
}

function stubState(packet: OrchestratorPacket): OrchestratorMissionState {
  return {
    version: 2,
    prompt: 'test',
    summary: 'test',
    packets: [packet],
    updatedAt: new Date().toISOString(),
  };
}

describe('runtimeFromSessionKey', () => {
  it('recognizes OpenCode owned and provider session keys without widening unknown prefixes', () => {
    expect(runtimeFromSessionKey('opencode-owned:session-xyz')).toBe('opencode');
    expect(runtimeFromSessionKey('opencode:session-xyz')).toBe('opencode');
    expect(runtimeFromSessionKey('unknown:session-xyz')).toBeNull();
  });
});

describe('aggregateMissionCost', () => {
  it('prefers live lane session data over a stale packet lane binding', async () => {
    const packet = stubPacket({
      lane: {
        tileId: 'stale-tile',
        tabId: 'stale-tab',
        repoPath: null,
        runtime: 'claude-code',
        sessionKey: 'claude-code:stale',
      },
    });
    const liveLane: LaneSessionInfo = {
      sessionKey: 'opencode-owned:live-session',
      runtime: 'opencode',
    };

    const result = await aggregateMissionCost(
      stubState(packet),
      new Map([[packet.id, liveLane]]),
    );

    expect(result.packetCosts[0]).toMatchObject({
      sessionKey: 'opencode-owned:live-session',
      runtime: 'opencode',
      hasTelemetry: false,
    });
  });

  it('keeps telemetry unavailable when neither persisted nor live session data exists', async () => {
    const result = await aggregateMissionCost(stubState(stubPacket({})));

    expect(result.packetCosts[0]).toMatchObject({
      sessionKey: null,
      hasTelemetry: false,
      totalCostUsd: 0,
    });
    expect(result.totalCostUsd).toBe(0);
  });
});
