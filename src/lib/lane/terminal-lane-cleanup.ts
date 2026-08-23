import type { Lane } from './types';
import { cleanupLaneWorktree } from './worktree-cleanup';
import { releaseTerminalPacketStorageReservations } from '@/lib/orchestrator/terminal-storage-release';

type TerminalCleanupLane = Pick<Lane, 'id' | 'repoPath' | 'worktreePath' | 'packetId'>
  & Partial<Pick<Lane, 'baseBranch'>>;

function releaseWithoutWorktree(lane: TerminalCleanupLane): void {
  try {
    releaseTerminalPacketStorageReservations({ packetId: lane.packetId, laneId: lane.id });
  } catch (error) {
    console.error(
      `[storage-admission] Terminal reservation release failed for ${lane.id}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function scheduleTerminalLaneCleanup(lane: TerminalCleanupLane): void {
  if (!lane.worktreePath) {
    releaseWithoutWorktree(lane);
    return;
  }
  void cleanupLaneWorktree(lane, { terminal: true }).catch((error) => {
    console.error(
      `[lane-worktree] Terminal cleanup failed for ${lane.id}: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
}
