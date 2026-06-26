'use client';

import { useMemo } from 'react';

import type { OrchestratorMissionState, OrchestratorPacket } from '@/lib/orchestrator/types';

/**
 * useComparisonGroups — single source of truth for best-of-N comparison groups,
 * derived from mission state. Consumed by the in-chat ComparisonPicker AND the
 * N-up compare matrix (item 3). Each group exposes the raw packets (the existing
 * OrchestratorTab consumers) plus an enriched per-candidate view the matrix needs
 * (worktree path = its diff source, status, reviewed HEAD for the gated pick).
 */

/**
 * A comparison packet is "complete" — its candidate diff is settled enough to
 * compare + pick — once it reaches an awaiting-review/terminal state or carries a
 * review. (Lifted verbatim from OrchestratorTab so the picker + matrix agree.)
 */
export function isComparisonPacketComplete(packet: OrchestratorPacket): boolean {
  return packet.status === 'awaiting_review'
    || packet.status === 'released'
    || packet.status === 'archived'
    || packet.status === 'failed'
    || Boolean(packet.review);
}

export interface ComparisonCandidate {
  packet: OrchestratorPacket;
  /** The candidate's isolated worktree path — the diff source for its column. */
  worktreePath: string | null;
  status: OrchestratorPacket['status'];
  /** HEAD the candidate was reviewed at — the HEAD-matched key for the gated pick. */
  reviewedHeadSha: string | null;
  /** Settled enough to compare (see isComparisonPacketComplete). */
  complete: boolean;
}

export interface ComparisonGroup {
  groupId: string;
  /** Raw packets — the existing OrchestratorTab consumers (auto-tile, picker). */
  packets: OrchestratorPacket[];
  /** Enriched per-candidate view — the N-up compare matrix. */
  candidates: ComparisonCandidate[];
  /** Every candidate is complete — the group is ready to compare + pick a winner. */
  ready: boolean;
}

function toCandidate(packet: OrchestratorPacket): ComparisonCandidate {
  return {
    packet,
    worktreePath: packet.lane?.worktreePath ?? packet.lane?.repoPath ?? null,
    status: packet.status,
    reviewedHeadSha: packet.review?.reviewedHeadSha ?? null,
    complete: isComparisonPacketComplete(packet),
  };
}

export function useComparisonGroups(
  missionState: OrchestratorMissionState | null | undefined,
): { groups: ComparisonGroup[]; readyGroups: ComparisonGroup[] } {
  const groups = useMemo<ComparisonGroup[]>(() => {
    if (!missionState) return [];
    return (missionState.activeComparisonGroups ?? [])
      .map((groupId) => {
        const packets = missionState.packets.filter((packet) => packet.comparisonGroupId === groupId);
        const candidates = packets.map(toCandidate);
        return {
          groupId,
          packets,
          candidates,
          ready: candidates.length > 0 && candidates.every((candidate) => candidate.complete),
        };
      })
      .filter((group) => group.packets.length > 0);
  }, [missionState]);

  const readyGroups = useMemo(() => groups.filter((group) => group.ready), [groups]);

  return { groups, readyGroups };
}
