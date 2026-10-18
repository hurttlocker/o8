import type { OrchestratorPacket } from '@/lib/orchestrator/types';

export type DemoRuntime = 'codex' | 'claude-code';

export function demoPacket(id: string, title: string, runtime: DemoRuntime, status: OrchestratorPacket['status'] = 'running'): OrchestratorPacket {
  return {
    id, title, runtime, status, summary: 'Illustrative task', referenceLabel: 'Demo',
    workspaceTargetPath: '', branchTarget: '', dependencyLabels: [], dependencyPacketIds: [],
    queueState: 'queued', releaseState: 'pending',
    lane: { laneId: id, tileId: id, tabId: id, repoPath: '', runtime },
  };
}

export function initialDemoPackets(): OrchestratorPacket[] {
  return [
    demoPacket('demo-layout', 'Refine the composer layout', 'codex'),
    demoPacket('demo-review', 'Review keyboard navigation', 'claude-code', 'awaiting_review'),
  ];
}
