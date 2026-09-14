import { recordLaneEvent } from '@/lib/lane/events';
import {
  releasePacketStorageAfterWorktreeProvisionFailure,
  type PacketWorktreeProvisionStorageRelease,
} from '@/lib/lane/lane-storage-release';
import { getLane, setLaneStatus } from '@/lib/lane/registry';
import type { LaneStatus } from '@/lib/lane/types';

export const PACKET_WORKTREE_PROVISION_FAILED = 'packet_worktree_provision_failed';

interface PacketWorktreeRequest {
  existingLaneId?: string;
  isolate?: boolean;
  packetId?: string;
}

export function packetRequiresWorktree(request: PacketWorktreeRequest): boolean {
  return Boolean(request.existingLaneId && request.packetId && request.isolate);
}

export function packetWorktreeProvisionError(
  request: PacketWorktreeRequest,
  runtime: string,
  repoPath: string,
  causeInput: unknown,
  note: string,
  laneStatus?: Extract<LaneStatus, 'awaiting_input' | 'failed'>,
): Error {
  if (!packetRequiresWorktree(request)) {
    return causeInput instanceof Error ? causeInput : new Error(note);
  }

  const laneId = request.existingLaneId!;
  const packetId = request.packetId!;
  const cause = causeInput instanceof Error ? causeInput.message : String(causeInput);
  const lane = getLane(laneId);
  let storageRelease: PacketWorktreeProvisionStorageRelease = {
    decision: 'deferred',
    ownerGeneration: null,
    releasedReservations: 0,
    releasedBytes: 0,
    retainedOwnerIds: [packetId],
    reason: 'packet_association_unprovable',
  };
  if (lane) {
    try {
      storageRelease = releasePacketStorageAfterWorktreeProvisionFailure(lane, packetId);
    } catch (error) {
      storageRelease = {
        ...storageRelease,
        reason: 'storage_release_failed',
        error: error instanceof Error ? error.message : String(error),
      };
      console.warn(
        `[runtime-launch] Failed to release packet storage after worktree provision failure for ${laneId}:`,
        error,
      );
    }
  }
  if (lane?.status === 'launching') {
    setLaneStatus(
      laneId,
      storageRelease.decision === 'deferred' ? 'awaiting_input' : laneStatus ?? 'failed',
      'system',
      PACKET_WORKTREE_PROVISION_FAILED,
    );
  }
  try {
    recordLaneEvent(laneId, 'worktree_provision_failed', 'system', {
      code: PACKET_WORKTREE_PROVISION_FAILED,
      runtime,
      packetId,
      laneId,
      repoPath,
      cause,
      note,
      storageRelease,
    });
  } catch (error) {
    console.warn(
      `[runtime-launch] Failed to record ${PACKET_WORKTREE_PROVISION_FAILED} for ${laneId}:`,
      error,
    );
  }

  return new Error(
    `[${PACKET_WORKTREE_PROVISION_FAILED}] Cannot launch ${runtime} packet outside a managed worktree: ${note}`,
  );
}
