import { recommendRuntime } from '@/lib/dispatch/routing';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';

export async function logDispatchRoutingRecommendations(
  packets: OrchestratorPacket[],
  missionId: string,
): Promise<void> {
  const byRepo = new Map<string, OrchestratorPacket[]>();
  for (const packet of packets) {
    const repo = packet.workspaceTargetPath?.trim();
    if (!repo) continue;
    byRepo.set(repo, [...(byRepo.get(repo) ?? []), packet]);
  }
  for (const [repoPath, repoPackets] of byRepo) {
    const recommendation = await recommendRuntime(repoPath);
    for (const packet of repoPackets) {
      const evidenceSummary = Object.values(recommendation.evidence)
        .map((row) => `${row.runtime}=${row.mergedClean}/${row.total}`)
        .join(' ') || 'no-history';
      console.log(
        `[dispatch-routing] mission=${missionId} packet=${packet.referenceLabel} repo=${repoPath} chose=${packet.runtime} recommended=${recommendation.runtime ?? 'none'} score=${recommendation.score.toFixed(2)} matched=${recommendation.runtime !== null && packet.runtime === recommendation.runtime} evidence=${evidenceSummary}`,
      );
    }
  }
}
