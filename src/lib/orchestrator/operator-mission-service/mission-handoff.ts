import { recordMission } from '@/lib/db/missions-store';
import { buildDependencyGraph } from '@/lib/orchestrator/dag';
import type { OrchestratorMissionState } from '@/lib/orchestrator/types';

export function recordOutgoingMissionSnapshot(state: OrchestratorMissionState): void {
  const missionId = state.missionId?.trim();
  if (!missionId) throw new Error('Cannot hand off an outgoing mission without a mission id.');
  const waves = buildDependencyGraph(state.packets).map((node) => node.wave);
  recordMission({
    id: missionId,
    repoPath: state.repoPath ?? '',
    runtime: state.runtime ?? 'codex',
    prompt: state.prompt,
    summary: state.summary,
    constraints: state.constraints ?? '',
    packetMeta: state.packets.map((packet) => ({
      id: packet.id,
      title: packet.title,
      referenceLabel: packet.referenceLabel,
    })),
    missionState: structuredClone(state),
    totalWaves: Math.max(1, ...waves),
  });
}
