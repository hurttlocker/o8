import { listApprovalsForContext } from '@/lib/approvals/store';
import { dispatch as dispatchLaneCommand } from '@/lib/lane/commands';
import { archiveLane, findLaneByPacket } from '@/lib/lane/registry';
import { withLockedState } from '@/lib/orchestrator/control-plane';
import { buildDependencyGraph } from '@/lib/orchestrator/dag';
import { runDispatchTick } from '@/lib/orchestrator/dispatch';
import {
  syncOrchestratorControlPlaneState,
  writeOrchestratorControlPlaneState,
} from '@/lib/orchestrator/control-plane';
import type { OrchestratorMissionState, OrchestratorPacket } from '@/lib/orchestrator/types';
import { detectFileOverlaps, recommendMergeOrder } from '@/lib/worktree/conflicts';
import type { MergeOrderRecommendation } from '@/lib/worktree/conflicts';
import { getWorktreeManager } from '@/lib/worktree/launch';
import type { WorktreeInfo } from '@/lib/worktree/types';
import { mapReviewSummary } from './review';
import { currentMissionState, log } from './shared';
import type {
  ApproveAndMergeInput,
  MergePacketResult,
  PickComparisonWinnerInput,
} from './types';

type ActivePacketLane = NonNullable<ReturnType<typeof findLaneByPacket>>;

interface MergeOrderCandidate {
  packet: OrchestratorPacket;
  lane: ActivePacketLane;
  worktree: WorktreeInfo;
}

interface OrderedMergeCandidate extends MergeOrderCandidate {
  recommendation: MergeOrderRecommendation;
}

function isPacketAwaitingMerge(packet: OrchestratorPacket) {
  return packet.status === 'awaiting_review'
    && packet.releaseState !== 'released'
    && packet.review?.approved !== false;
}

async function getWaveMergeOrder(
  state: OrchestratorMissionState,
  packetId: string,
): Promise<OrderedMergeCandidate[] | null> {
  const graph = buildDependencyGraph(state.packets);
  const packetById = new Map(state.packets.map((packet) => [packet.id, packet] as const));
  const targetNode = graph.find((node) => node.packetId === packetId);
  if (!targetNode) {
    return null;
  }

  const targetPacket = packetById.get(packetId);
  const repoPath = state.repoPath ?? targetPacket?.workspaceTargetPath ?? null;
  if (!repoPath) {
    return null;
  }

  const sameWavePackets = graph
    .filter((node) => node.wave === targetNode.wave)
    .map((node) => packetById.get(node.packetId))
    .filter((packet): packet is OrchestratorPacket => packet !== undefined && isPacketAwaitingMerge(packet));

  if (sameWavePackets.length <= 1) {
    return null;
  }

  const worktrees = await getWorktreeManager(repoPath).list();
  const worktreeByPath = new Map(worktrees.map((worktree) => [worktree.path, worktree] as const));
  const candidates = sameWavePackets.flatMap((packet) => {
    const lane = findLaneByPacket(packet.id);
    if (!lane?.worktreePath) {
      return [];
    }

    const worktree = worktreeByPath.get(lane.worktreePath);
    if (!worktree) {
      return [];
    }

    return [{ packet, lane, worktree }];
  });

  if (candidates.length <= 1) {
    return null;
  }

  const candidateWorktrees = candidates.map((candidate) => candidate.worktree);
  const overlaps = detectFileOverlaps(candidateWorktrees);
  const recommendations = await recommendMergeOrder(candidateWorktrees, overlaps);
  const candidateByWorktreeId = new Map(candidates.map((candidate) => [candidate.worktree.id, candidate] as const));

  const ordered = recommendations.flatMap((recommendation) => {
    const candidate = candidateByWorktreeId.get(recommendation.worktreeId);
    return candidate ? [{ ...candidate, recommendation }] : [];
  });

  if (ordered.length <= 1) {
    return null;
  }

  console.log('[merge-order]', {
    wave: targetNode.wave,
    requestedPacketId: packetId,
    sequence: ordered.map(({ packet, worktree, recommendation }) => ({
      position: recommendation.position,
      packetId: packet.id,
      referenceLabel: packet.referenceLabel,
      title: packet.title,
      worktreeId: worktree.id,
      agentType: recommendation.agentType,
      fileCount: recommendation.fileCount,
      totalChanges: recommendation.totalChanges,
      reason: recommendation.reason,
    })),
  });

  return ordered;
}

function findLatestMergeApproval(packetId: string, laneId: string, sessionKey?: string | null) {
  return listApprovalsForContext({
    packetId,
    laneId,
    sessionKey: sessionKey ?? undefined,
  }).find((approval) => approval.continuation?.kind === 'lane' && approval.continuation.verb === 'merge') ?? null;
}

async function dispatchPacketMerge(
  packet: OrchestratorPacket,
  input: ApproveAndMergeInput,
  actor: 'orchestrator' | 'user',
): Promise<MergePacketResult> {
  const lane = findLaneByPacket(packet.id);
  if (!lane) {
    throw new Error(`Packet ${packet.id} is not bound to an active lane.`);
  }

  const result = await dispatchLaneCommand({
    verb: 'merge',
    laneId: lane.id,
    commitMessage: input.commitMessage?.trim() || undefined,
    reviewSummary: mapReviewSummary(packet),
    orchestratorReviewed: packet.review?.approved === true,
    actor,
  });

  // Sync first so reconciliation runs, then apply the release on top.
  // This prevents reconciliation from resetting the packet status after we set it.
  // Pass undefined so sync re-reads inside the mutex — otherwise we race the
  // /api/orchestrator/state GET poll and other concurrent writers.
  const synced = await syncOrchestratorControlPlaneState();

  if (result.ok) {
    for (const packetState of synced.packets) {
      if (packetState.id === input.packetId) {
        packetState.status = 'released';
        packetState.queueState = 'held';
        packetState.releaseState = 'released';
        packetState.blockedReason = null;
        if (packetState.lane) {
          packetState.lane.lastEventLabel = 'merged';
        }
        break;
      }
    }
  }

  const afterDispatch = await runDispatchTick(synced);
  writeOrchestratorControlPlaneState(afterDispatch);

  log(`Merge command finished for packet ${packet.id}.`, {
    ok: result.ok,
    approvalId: result.approvalId ?? null,
    actor,
  });

  return {
    merged: result.ok,
    note: result.note,
    ...(result.approvalId ? { approvalId: result.approvalId } : {}),
  };
}

async function approveAndMergeSinglePacket(input: ApproveAndMergeInput): Promise<MergePacketResult> {
  const state = currentMissionState();
  const packet = state.packets.find((candidate) => candidate.id === input.packetId);
  if (!packet) {
    // #557 — Fall through to lane-only merge when the mission packet is missing.
    const { mergeOrphanLaneByPacket } = await import('../orphan-lane-merge');
    return mergeOrphanLaneByPacket(input.packetId, input.commitMessage);
  }

  if (packet.review && !packet.review.approved) {
    return {
      merged: false,
      note: 'Packet review is not approved. Resolve findings before merging.',
    };
  }
  if (packet.releaseState === 'released' || packet.status === 'released') {
    return {
      merged: true,
      note: `Packet ${packet.referenceLabel} is already released.`,
    };
  }

  const lane = findLaneByPacket(packet.id);
  if (!lane) {
    throw new Error(`Packet ${packet.id} is not bound to an active lane.`);
  }
  const latestMergeApproval = findLatestMergeApproval(packet.id, lane.id, lane.sessionKey);
  if (latestMergeApproval?.status === 'pending') {
    return {
      merged: false,
      note: latestMergeApproval.policyRuleId === 'merge-gate-violation'
        ? 'Merge gate enforcement: human review required.'
        : `Approval required: ${latestMergeApproval.title}`,
      approvalId: latestMergeApproval.id,
    };
  }
  if (latestMergeApproval?.status === 'approved' && (lane.status === 'completed' || lane.status === 'archived')) {
    await syncOrchestratorControlPlaneState();
    return {
      merged: true,
      note: `Packet ${packet.referenceLabel} was already merged after approval.`,
    };
  }

  const mergeActor = latestMergeApproval?.status === 'approved' ? 'user' : 'orchestrator';
  return dispatchPacketMerge(packet, input, mergeActor);
}

export async function approveAndMergePacket(input: ApproveAndMergeInput) {
  const state = currentMissionState();
  const packet = state.packets.find((candidate) => candidate.id === input.packetId);
  // #557 — Missing packet falls through to single-packet merge (lane fallback).
  if (!packet) return approveAndMergeSinglePacket(input);

  const orderedWavePackets = await getWaveMergeOrder(state, packet.id);
  if (!orderedWavePackets) {
    return approveAndMergeSinglePacket(input);
  }

  const targetIndex = orderedWavePackets.findIndex((candidate) => candidate.packet.id === packet.id);
  if (targetIndex === -1) {
    return approveAndMergeSinglePacket(input);
  }

  const mergeSequence = orderedWavePackets.slice(0, targetIndex + 1);
  const mergedPrerequisites: string[] = [];
  let requestedResult: MergePacketResult | null = null;

  for (const candidate of mergeSequence) {
    const result = await approveAndMergeSinglePacket({
      packetId: candidate.packet.id,
      commitMessage: candidate.packet.id === packet.id ? input.commitMessage : undefined,
    });

    if (!result.merged) {
      return {
        merged: false,
        note: candidate.packet.id === packet.id
          ? result.note
          : `Merge order requires ${candidate.packet.referenceLabel} to merge before ${packet.referenceLabel}: ${result.note}`,
        ...(result.approvalId ? { approvalId: result.approvalId } : {}),
      };
    }

    if (candidate.packet.id !== packet.id) {
      mergedPrerequisites.push(candidate.packet.referenceLabel);
      continue;
    }

    requestedResult = result;
  }

  if (!requestedResult) {
    return {
      merged: false,
      note: `Packet ${packet.referenceLabel} was not included in the recommended merge sequence.`,
    };
  }

  return {
    merged: true,
    note: mergedPrerequisites.length > 0
      ? `Merged ${mergedPrerequisites.join(', ')} before ${packet.referenceLabel} based on recommended same-wave merge order. ${requestedResult.note}`
      : requestedResult.note,
  };
}

export async function pickComparisonWinner(input: PickComparisonWinnerInput) {
  const state = currentMissionState();
  const winner = state.packets.find((candidate) => candidate.id === input.packetId);
  if (!winner) {
    throw new Error(`Packet ${input.packetId} not found.`);
  }

  const comparisonGroupId = winner.comparisonGroupId?.trim();
  if (!comparisonGroupId) {
    throw new Error(`Packet ${winner.id} is not part of a comparison group.`);
  }

  const comparisonPackets = state.packets.filter((packet) => packet.comparisonGroupId === comparisonGroupId);
  if (comparisonPackets.length < 2) {
    throw new Error(`Comparison group ${comparisonGroupId} has no alternate candidates to compare.`);
  }

  const archivedPacketIds = comparisonPackets
    .filter((packet) => packet.id !== winner.id)
    .map((packet) => packet.id);
  const archivedAt = new Date().toISOString();

  await withLockedState(async (current) => {
    const activeComparisonGroups = new Set(current.activeComparisonGroups ?? []);
    activeComparisonGroups.delete(comparisonGroupId);
    current.activeComparisonGroups = [...activeComparisonGroups];

    for (const packet of current.packets) {
      if (packet.comparisonGroupId !== comparisonGroupId) {
        continue;
      }

      if (packet.id === winner.id) {
        packet.lastEventAt = archivedAt;
        packet.lastEventLabel = 'comparison_winner_selected';
        if (packet.lane) {
          packet.lane.lastEventAt = archivedAt;
          packet.lane.lastEventLabel = 'comparison_winner_selected';
        }
        continue;
      }

      packet.archivedAt = archivedAt;
      packet.status = 'archived';
      packet.queueState = 'held';
      packet.blockedReason = null;
      packet.lastEventAt = archivedAt;
      packet.lastEventLabel = 'comparison_loser_archived';
      if (packet.lane) {
        packet.lane.lastEventAt = archivedAt;
        packet.lane.lastEventLabel = 'comparison_loser_archived';
      }

      if (packet.lane?.laneId) {
        archiveLane(packet.lane.laneId, 'user');
      }
    }
  });

  const mergeResult = await approveAndMergePacket({
    packetId: winner.id,
    commitMessage: input.commitMessage,
  });

  return {
    ...mergeResult,
    groupId: comparisonGroupId,
    archivedPacketIds,
  };
}
