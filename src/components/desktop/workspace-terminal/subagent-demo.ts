import { ORCHESTRATOR_RUNTIMES } from '@/lib/orchestrator/runtime-capabilities';
import type { OrchestratorPacket, OrchestratorRuntime } from '@/lib/orchestrator/types';

export type DemoRuntime = OrchestratorRuntime;
export const DEMO_RUNTIMES = (Object.keys(ORCHESTRATOR_RUNTIMES) as OrchestratorRuntime[])
  .filter(runtime => ORCHESTRATOR_RUNTIMES[runtime].dispatchable);

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


export function allDemoPackets(): OrchestratorPacket[] {
  const initial = initialDemoPackets();
  return DEMO_RUNTIMES.map(runtime => initial.find(packet => packet.runtime === runtime)
    ?? demoPacket(`demo-${runtime}`, `Inspect with ${ORCHESTRATOR_RUNTIMES[runtime].label}`, runtime));
}
