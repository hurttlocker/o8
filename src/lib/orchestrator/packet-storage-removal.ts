import { getSqlite } from '@/lib/db';
import { latestReservedStorageOwnerGeneration } from '@/lib/workspace/storage-admission-terminal-release';
import { packetTerminalState } from './packet-state';
import type { OrchestratorPacket } from './types';
import { resolvePacketCheckout } from './storage-admission-owner-liveness';
import { releaseTerminalPacketStorageReservations } from './terminal-storage-release';

/**
 * Settle every packet-owned reservation before deleting the final durable
 * packet record. An explicit terminal removal plus affirmative checkout
 * absence proves that even a newer legacy generation, reserved before its lane
 * receipt was recorded, no longer owns storage.
 */
export async function settlePacketStorageBeforeRemoval(
  packet: OrchestratorPacket,
): Promise<void> {
  const admission = packet.storageAdmission;
  if (admission && (admission.ownerId !== packet.id
    || !Number.isSafeInteger(admission.ownerGeneration)
    || admission.ownerGeneration <= 0)) {
    throw new Error(`Packet ${packet.id} has no provable storage admission owner generation.`);
  }
  const latestReservedGeneration = latestReservedStorageOwnerGeneration(getSqlite(), packet.id);
  const widensRecordedScope = latestReservedGeneration
    && latestReservedGeneration > (admission?.ownerGeneration ?? 0);
  if (widensRecordedScope && !packetTerminalState(packet)) {
    throw new Error(
      `Refusing to widen storage removal for packet ${packet.id}: packet state is not terminal.`,
    );
  }

  const checkout = await resolvePacketCheckout(packet);
  if (checkout.state !== 'absent') {
    throw new Error(
      `Refusing to remove packet ${packet.id}: checkout absence is ${checkout.state}. ${checkout.evidence}`,
    );
  }

  const ownerGeneration = Math.max(
    admission?.ownerGeneration ?? 0,
    latestReservedGeneration ?? 0,
  );
  if (ownerGeneration <= 0) return;

  releaseTerminalPacketStorageReservations({
    packetId: packet.id,
    laneId: packet.lane?.laneId?.trim() || `packet-removal-${packet.id}`,
    ownerGeneration,
  });
}
