// #772 — Pure render-time grouping for Mission Control packets.
// Maps each OrchestratorPacket onto one of six fixed status buckets so the
// Mission panel can render Linear-style sectioned lists without touching
// the data layer.

import type { OrchestratorPacket } from '@/lib/orchestrator/types';

export type PacketGroupId =
  | 'in_progress'
  | 'in_review'
  | 'backlog'
  | 'done'
  | 'cancelled'
  | 'archived';

export interface PacketGroupDef {
  id: PacketGroupId;
  /** Uppercase Rams-style label rendered in the section header. */
  label: string;
  /** Whether the section should default to expanded on first render. */
  defaultOpen: boolean;
}

/**
 * Fixed display order — matches the spec on #772.
 * In Progress → In Review → Backlog → Done → Cancelled → Archived.
 *
 * In Progress + In Review default to expanded. Backlog/Done/Cancelled/Archived
 * default to collapsed so the visible operator pipeline stays focused on
 * "what's actively flowing" without dropping context for completed work.
 */
export const PACKET_GROUP_ORDER: readonly PacketGroupDef[] = [
  { id: 'in_progress', label: 'In Progress', defaultOpen: true },
  { id: 'in_review', label: 'In Review', defaultOpen: true },
  { id: 'backlog', label: 'Backlog', defaultOpen: false },
  { id: 'done', label: 'Done', defaultOpen: false },
  { id: 'cancelled', label: 'Cancelled', defaultOpen: false },
  { id: 'archived', label: 'Archived', defaultOpen: false },
];

/**
 * Bucket a single packet onto a status group.
 *
 * Mapping rules (derived from existing OrchestratorPacketStatus + flags):
 * - Archived bucket wins first — `archivedAt` set OR `status === 'archived'`
 *   means the operator manually archived the row.
 * - Done — `status === 'released'` OR `releaseState === 'released'`.
 *   Released = merged. The display layer in `lib/orchestrator/display.ts`
 *   already labels this state "Completed", which we surface as Done.
 * - In Review — `status === 'awaiting_review'`. The packet has a worktree
 *   diff waiting on the human merge gate.
 * - Backlog — `queueState === 'draft'` AND no lane binding yet. These are
 *   packets the operator has scoped but not dispatched.
 * - In Progress — everything live: queued/launching/running/idle (lane
 *   spawned) + recovering/failed/blocked. Failed/blocked stay visible at
 *   the top because the operator needs to act on them, not because the
 *   work is "in progress" in the strict sense.
 *
 * Cancelled is currently never assigned — packets don't carry a
 * `cancelled` status today, and the issue (#772) said "No new data model".
 * The bucket exists so the section header renders consistently the moment
 * a future cancellation flow lands. Empty sections collapse, so it stays
 * hidden until then.
 */
export function classifyPacketGroup(packet: OrchestratorPacket): PacketGroupId {
  if (packet.archivedAt || packet.status === 'archived') {
    return 'archived';
  }
  if (packet.status === 'released' || packet.releaseState === 'released') {
    return 'done';
  }
  if (packet.status === 'awaiting_review') {
    return 'in_review';
  }
  if (packet.queueState === 'draft' && !packet.lane?.laneId) {
    return 'backlog';
  }
  return 'in_progress';
}

/**
 * Group an ordered list of packets into the fixed six-bucket layout.
 * Preserves input order within each bucket so operators see packets in
 * the same sequence the parent Mission panel feeds them.
 *
 * Comparison-group siblings are passed through unchanged — the caller
 * still dedupes them at render time via `comparisonGroupId`.
 */
export function groupPacketsByStatus(
  packets: readonly OrchestratorPacket[],
): Record<PacketGroupId, OrchestratorPacket[]> {
  const result: Record<PacketGroupId, OrchestratorPacket[]> = {
    in_progress: [],
    in_review: [],
    backlog: [],
    done: [],
    cancelled: [],
    archived: [],
  };
  for (const packet of packets) {
    result[classifyPacketGroup(packet)].push(packet);
  }
  return result;
}
