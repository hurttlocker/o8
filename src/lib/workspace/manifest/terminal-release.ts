import 'server-only';

import { releaseWorkspacePortLeases } from './port-leases';

export function scheduleWorkspaceManifestLeaseRelease(input: {
  packetId?: string | null;
  laneId: string;
}): void {
  void releaseWorkspacePortLeases(input).catch((error) => {
    console.error(
      `[workspace-manifest] Terminal port lease release failed for ${input.laneId}: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
}
