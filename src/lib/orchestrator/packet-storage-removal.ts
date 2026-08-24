import type { OrchestratorPacket } from './types';
import { resolvePacketCheckout } from './storage-admission-owner-liveness';
import { releaseTerminalPacketStorageReservations } from './terminal-storage-release';

/**
 * Settle the exact storage generation before deleting its final durable packet
 * record. Once that record is gone, lease reconciliation cannot prove which
 * checkout the reservation described, so removal fails closed unless checkout
 * absence is affirmative.
 */
export async function settlePacketStorageBeforeRemoval(
  packet: OrchestratorPacket,
): Promise<void> {
  const admission = packet.storageAdmission;
  if (!admission) return;
  if (admission.ownerId !== packet.id
    || !Number.isSafeInteger(admission.ownerGeneration)
    || admission.ownerGeneration <= 0) {
    throw new Error(`Packet ${packet.id} has no provable storage admission owner generation.`);
  }

  const checkout = await resolvePacketCheckout(packet);
  if (checkout.state !== 'absent') {
    throw new Error(
      `Refusing to remove packet ${packet.id}: checkout absence is ${checkout.state}. ${checkout.evidence}`,
    );
  }

  releaseTerminalPacketStorageReservations({
    packetId: packet.id,
    laneId: packet.lane?.laneId?.trim() || `packet-removal-${packet.id}`,
    ownerGeneration: admission.ownerGeneration,
  });
}
