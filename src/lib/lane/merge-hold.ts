/**
 * Mission merge hold (#3740). A packet created with `holdMerges` stops at an
 * approved review: every merge that does not come from the operator routes to
 * an approval card instead of merging, so "do not merge" survives the
 * reviewer's and the lead's merge calls.
 */

import { findMissionRegistryEntryByPacketId } from '@/lib/orchestrator/mission-registry';

export const MERGE_HOLD_POLICY_RULE_ID = 'mission-merge-hold';

export function isPacketMergeHeld(packetId: string | null | undefined): boolean {
  const id = packetId?.trim();
  if (!id) return false;
  const entry = findMissionRegistryEntryByPacketId(id, { includeArchived: true });
  return entry?.mission.packets.some((packet) => packet.id === id && packet.mergeHold === true) ?? false;
}
