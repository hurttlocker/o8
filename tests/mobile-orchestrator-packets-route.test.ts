import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';

const syncOrchestratorControlPlaneState = vi.fn();
const findLaneByPacket = vi.fn(() => null);
const getLaneEvents = vi.fn(() => []);

vi.mock('@/lib/orchestrator/control-plane', () => ({
  syncOrchestratorControlPlaneState,
}));

vi.mock('@/lib/lane/registry', () => ({
  findLaneByPacket,
  getLaneEvents,
}));

const { GET } = await import('@/app/api/mobile/orchestrator/packets/route');

function request() {
  return new NextRequest('http://localhost:3001/api/mobile/orchestrator/packets?repoPath=%2Ftmp%2Fo8');
}

function packet(overrides: Partial<OrchestratorPacket> = {}): OrchestratorPacket {
  return {
    id: 'pkt-recoverable',
    referenceLabel: '#1595',
    title: 'Preserved review',
    summary: 'Reviewed work survived cleanup',
    workspaceTargetPath: '/tmp/o8',
    branchTarget: 'preserved/packet-pkt-recoverable',
    runtime: 'pi',
    dependencyLabels: [],
    dependencyPacketIds: [],
    queueState: 'held',
    releaseState: 'pending',
    status: 'archived',
    recovery: {
      outcome: 'archived_recoverable',
      preservedRef: 'preserved/packet-pkt-recoverable',
      preservedHeadSha: 'abc123',
      message: 'Reviewed work preserved at preserved/packet-pkt-recoverable — retry/redispatch to resume.',
      recommendedAction: 'retry_packet',
    },
    ...overrides,
  } as OrchestratorPacket;
}

describe('mobile orchestrator packet projection', () => {
  beforeEach(() => {
    findLaneByPacket.mockClear();
    getLaneEvents.mockClear();
    syncOrchestratorControlPlaneState.mockReset();
  });

  it('does not mislabel archived recoverable work as merged or erase its runtime and recovery ref', async () => {
    syncOrchestratorControlPlaneState.mockResolvedValue({ packets: [packet()] });

    const response = await GET(request());
    const payload = await response.json();

    expect(payload.agents).toHaveLength(1);
    expect(payload.agents[0]).toMatchObject({
      id: 'pkt-recoverable',
      runtime: 'pi',
      status: 'failed',
      recovery: {
        outcome: 'archived_recoverable',
        preservedRef: 'preserved/packet-pkt-recoverable',
        preservedHeadSha: 'abc123',
      },
    });
  });
});
