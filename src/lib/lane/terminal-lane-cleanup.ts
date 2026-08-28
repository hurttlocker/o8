import type { Lane } from './types';
import { cleanupLaneWorktree } from './worktree-cleanup';
import { releaseTerminalPacketStorageReservations } from '@/lib/orchestrator/terminal-storage-release';
import { settleTerminalWorkspaceManifestAndLeases } from '@/lib/workspace/manifest/terminal-release';
import { laneOwnsWorktree } from './lane-storage-release';

type TerminalCleanupLane = Pick<Lane, 'id' | 'repoPath' | 'worktreePath' | 'packetId'>
  & Partial<Pick<Lane, 'baseBranch'>>
  & { storageAdmissionOwnerGeneration?: number };

function releaseWithoutWorktree(lane: TerminalCleanupLane): void {
  try {
    releaseTerminalPacketStorageReservations({
      packetId: lane.packetId,
      laneId: lane.id,
      ownerGeneration: lane.storageAdmissionOwnerGeneration,
    });
  } catch (error) {
    console.error(
      `[storage-admission] Terminal reservation release failed for ${lane.id}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function scheduleTerminalLaneCleanup(lane: TerminalCleanupLane): void {
  void (async () => {
    try {
      await settleTerminalWorkspaceManifestAndLeases({
        worktreePath: lane.worktreePath,
        packetId: lane.packetId,
        laneId: lane.id,
      });
    } catch (error) {
      console.error(
        `[lane-worktree] Terminal manifest cleanup failed for ${lane.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!lane.worktreePath || !laneOwnsWorktree(lane)) {
      releaseWithoutWorktree(lane);
      if (lane.worktreePath) {
        const { getLane, updateLane } = await import('./registry');
        if (getLane(lane.id)?.worktreePath === lane.worktreePath) {
          updateLane(lane.id, { worktreePath: null }, 'system', { phase: 'terminal_cleanup' });
        }
      }
      return;
    }
    const removed = await cleanupLaneWorktree(lane, { terminal: true });
    const { appendEvent, getLane, updateLane } = await import('./registry');
    const current = getLane(lane.id);
    if (removed && current?.worktreePath === lane.worktreePath) {
      updateLane(lane.id, { worktreePath: null }, 'system', {
        phase: 'terminal_cleanup',
        worktreeRemoved: true,
      });
      return;
    }
    if (!removed) {
      appendEvent(lane.id, 'update', 'system', {
        phase: 'terminal_cleanup',
        worktreeRemoved: false,
        worktreePath: lane.worktreePath,
      });
    }
  })().catch((error) => {
    console.error(
      `[lane-worktree] Terminal worktree cleanup failed for ${lane.id}: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
}
