import type { MissionBranchDecision } from './branch-cleanup';
import { log } from './shared';
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

export function logBranchPreparation(decisions: MissionBranchDecision[], missionId: string) {
  const prepared = decisions.filter((decision) => decision.action !== 'none');
  if (prepared.length === 0) return;
  log(`Prepared ${prepared.length} existing branch${prepared.length === 1 ? '' : 'es'} for mission ${missionId}.`, {
    branches: prepared.map((decision) => ({
      issue: decision.issueNumber,
      branch: decision.branchTarget,
      action: decision.action,
      reason: decision.reason,
      lanesArchived: decision.lanesArchived,
      worktreePruned: decision.worktreePruned,
      branchDeleted: decision.branchDeleted,
    })),
  });
}
