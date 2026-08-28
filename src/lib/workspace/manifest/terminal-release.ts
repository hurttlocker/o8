import 'server-only';

import type { Lane } from '@/lib/lane/types';
import { settleTerminalWorkspaceManifest } from './lifecycle';

export function settleTerminalWorkspaceManifestAndLeases(input: {
  worktreePath?: string | null;
  packetId?: string | null;
  laneId: string;
}): Promise<void> {
  return settleTerminalWorkspaceManifest({
    worktreePath: input.worktreePath,
    packetId: input.packetId?.trim() || `lane:${input.laneId}`,
    laneId: input.laneId,
  });
}

export function settleWorkspaceManifestOnTerminal(
  lane: Pick<Lane, 'id' | 'worktreePath' | 'packetId'>,
): void {
  void settleTerminalWorkspaceManifestAndLeases({
    worktreePath: lane.worktreePath,
    packetId: lane.packetId,
    laneId: lane.id,
  }).catch((error) => {
    console.error(
      `[workspace-manifest] Terminal settlement failed for ${lane.id}: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
}
