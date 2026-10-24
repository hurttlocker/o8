import { readOrchestratorControlPlaneState } from '@/lib/orchestrator/control-plane';
import { buildPreviewForLane, type MergeCheckResult } from './preview-merge';
import { packetStatusFromLaneStatus } from '@/lib/orchestrator/packet-state';
import type { LaneStatus } from './types';

/** Preview the same overlap-coupled sequence approveAndMergePacket dispatches. */
export async function mergeOrderPrerequisites(packetId: string, laneStatusProjection?: LaneStatus): Promise<MergeCheckResult[]> {
  const state = readOrchestratorControlPlaneState();
  if (state.packets.length < 2) return [];
  const { currentMissionState } = await import('@/lib/orchestrator/operator-mission-service/shared');
  const { getWaveMergeOrder, selectMergeSequence } = await import('@/lib/orchestrator/operator-mission-service/merge');
  const current = currentMissionState();
  const packet = current.packets.find(candidate => candidate.id === packetId);
  if (packet && laneStatusProjection) packet.status = packetStatusFromLaneStatus(laneStatusProjection) ?? packet.status;
  const ordered = await getWaveMergeOrder(current, packetId);
  if (!ordered) return [];
  const index = ordered.findIndex(candidate => candidate.packet.id === packetId);
  if (index < 0) return [];
  const checks: MergeCheckResult[] = [];
  for (const candidate of selectMergeSequence(ordered, index)) {
    if (candidate.packet.id === packetId) continue;
    try {
      const preview = await buildPreviewForLane(candidate.lane, candidate.packet.id, {
        orchestratorApproved: candidate.packet.review?.approved === true, skipMergeOrder: true,
      });
      if (preview.wouldMerge) continue;
      const contract = preview.reviewRequirements;
      checks.push({ name: 'merge-order', verdict: 'fail',
        detail: `${candidate.packet.id} must merge first: ${preview.blockers.join(', ')}. Contract: ${contract?.contractKind ?? 'unavailable'}; requirements: ${contract?.requirementIds.join(', ') ?? ''}; process constraints: ${contract?.processConstraintIds.join(', ') ?? ''}.`,
        actions: [...new Set([
          ...(contract?.actions ?? []), ...preview.checks.filter(check => check.verdict === 'fail').flatMap(check => check.actions ?? []),
          `Clear these gates on ${candidate.packet.id}, then retry o8 packet approve-merge ${packetId}.`,
        ])] });
    } catch (error) {
      checks.push({ name: 'merge-order', verdict: 'fail',
        detail: `Prerequisite ${candidate.packet.id} cannot be previewed: ${error instanceof Error ? error.message : 'workspace state is unavailable'}`,
        actions: [`Restore the prerequisite packet ${candidate.packet.id} workspace and review its branch ${candidate.lane.branch}; rerun o8 packet merge-preview ${candidate.packet.id} before merging ${packetId}.`] });
    }
  }
  return checks;
}
