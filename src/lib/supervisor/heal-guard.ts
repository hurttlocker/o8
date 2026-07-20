import 'server-only';

import { findLatestLaneByPacket } from '@/lib/lane/registry';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';

/**
 * #1391 — salvaged-work dispatch guard.
 *
 * A silent-exited worker's committed work is SALVAGED to a reviewing lane
 * (often with a PR already open). That lane is not a fault to heal: any
 * auto-redispatch re-implements merged/in-review work with a fresh worker
 * (live-hit 2026-07-03: the same packet was resurrected TWICE — once while its
 * salvaged PR was in review, once through an explicit reset hold — burning two
 * full codex runs). Every legitimate relaunch path (retry_packet,
 * rerun_with_feedback) ARCHIVES the packet's lanes before dispatching, so a
 * latest lane still in `reviewing` always means work is awaiting a decision.
 *
 * Called from getDispatchBlocker — the single funnel every dispatch path goes
 * through — so no heal/recovery/requeue variant can bypass it.
 */
export function salvagedWorkBlockReason(packet: OrchestratorPacket): string | null {
  if (!packet.id) return null;
  const lane = findLatestLaneByPacket(packet.id);
  if (!lane) return null;
  if (lane.status === 'reviewing' || lane.status === 'merging') {
    const detail = lane.lastEventLabel ? ` (${lane.lastEventLabel})` : '';
    return `Latest lane ${lane.id} is ${lane.status}${detail} — salvaged work awaits review; not healable`;
  }
  if (packet.review?.approved === true && lane.outcome === 'archived_recoverable') {
    return `Packet has reviewed recoverable work on lane ${lane.id} — retry or merge it; not healable`;
  }
  if (packet.review?.approved === true && lane.status !== 'archived' && lane.status !== 'completed') {
    return `Packet has an approved review on lane ${lane.id} — not healable`;
  }
  return null;
}
