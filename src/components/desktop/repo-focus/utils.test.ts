import { describe, expect, it } from 'vitest';

import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import { agentStatusToDotState } from '@/components/desktop/AgentStatusDot';
import { packetVisualState } from './utils';

function packet(overrides: Partial<OrchestratorPacket>): OrchestratorPacket {
  return {
    id: 'pkt-test',
    referenceLabel: 'inline-1',
    title: 'test packet',
    summary: 'test packet',
    workspaceTargetPath: '/tmp/repo',
    branchTarget: 'inline/test',
    runtime: 'codex',
    dependencyLabels: [],
    dependencyPacketIds: [],
    queueState: 'queued',
    releaseState: 'pending',
    status: 'queued',
    blockedReason: null,
    lane: null,
    review: null,
    ...overrides,
  } as OrchestratorPacket;
}

describe('packet rail state derivation', () => {
  it('maps released packets to a merged success dot state', () => {
    const visual = packetVisualState(packet({ releaseState: 'released', status: 'released' }));

    expect(visual).toBe('merged');
    expect(agentStatusToDotState(visual)).toBe('merged');
  });

  it('maps running packets to the working dot state', () => {
    const visual = packetVisualState(packet({ status: 'running' }));

    expect(visual).toBe('running');
    expect(agentStatusToDotState(visual)).toBe('running');
  });

  it('maps blocked packets to the attention dot state', () => {
    const visual = packetVisualState(packet({ status: 'blocked', queueState: 'held' }));

    expect(visual).toBe('failed');
    expect(agentStatusToDotState(visual)).toBe('failed');
  });
});
