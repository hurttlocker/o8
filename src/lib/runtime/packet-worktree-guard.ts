import { recordLaneEvent } from '@/lib/lane/events';
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
  const cause = causeInput instanceof Error ? causeInput.message : String(causeInput);
  const lane = getLane(laneId);
  if (lane?.status === 'launching') {
    setLaneStatus(
      laneId,
      laneStatus ?? 'failed',
      'system',
      PACKET_WORKTREE_PROVISION_FAILED,
    );
  }
  try {
    recordLaneEvent(laneId, 'worktree_provision_failed', 'system', {
      code: PACKET_WORKTREE_PROVISION_FAILED,
      runtime,
      packetId: request.packetId,
      laneId,
      repoPath,
      cause,
      note,
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
