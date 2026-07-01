import type { DomainLaneSummary } from '@/lib/orchestrator/store';

/**
 * The footer merge beacon's signal. A lane is "parked" — waiting on the
 * operator/orchestrator to act — when it sits in the review gate or an
 * escalation state. This is the true fleet "something's ready to land /
 * needs you" set in o8: most workers merge via worktree side-merge and
 * never open a GitHub PR, so the beacon keys on LANE STATE, not PR state.
 *
 * In-motion states (running / launching / merging) are deliberately
 * excluded so a packet that auto-reviews-and-merges in seconds never
 * lights the beacon — it only appears when something genuinely waits.
 */
const PARKED_STATUSES = new Set<string>([
  'reviewing', // agent finished, review gate open (the o8 approval moat)
  'awaiting_orchestrator', // merge-failure escalation, orchestrator's call
  'awaiting_human', // merge-failure escalation, operator's call
]);

export interface ParkedLane {
  laneId: string;
  packetId: string;
  status: string;
  branch?: string;
  repoPath?: string;
  label?: string;
}

/**
 * @param closedPacketIds packetIds whose packet is merged / released / archived
 *   (terminal). A lane's `status` can lag behind its packet — a packet merges +
 *   archives while the lane summary is still stale-stuck at 'reviewing' — which
 *   left the just-merged lane counting as "1 ready" in the footer beacon. Gating
 *   on the PACKET's terminal state (which IS updated on merge) drops it: a
 *   closed/merged/archived lane must never count as ready.
 */
export function deriveParkedLanes(
  lanes: DomainLaneSummary[],
  closedPacketIds?: ReadonlySet<string>,
): ParkedLane[] {
  return lanes
    .filter((l) => PARKED_STATUSES.has(l.status))
    .filter((l) => !closedPacketIds?.has(l.packetId))
    .map((l) => ({
      laneId: l.laneId,
      packetId: l.packetId,
      status: l.status,
      branch: l.branch,
      repoPath: l.repoPath,
      label: l.label,
    }));
}
