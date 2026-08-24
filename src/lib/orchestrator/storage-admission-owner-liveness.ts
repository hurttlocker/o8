import { lstat } from 'node:fs/promises';
import path from 'node:path';

import { listLanes } from '@/lib/lane/registry';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';

export interface PacketCheckoutResolution {
  state: 'present' | 'absent' | 'unknown';
  evidence: string;
}

/**
 * Resolve checkout ownership from both durable packet binding and the lane
 * ledger. Absence is affirmative only when every recorded path returns
 * ENOENT/ENOTDIR; permission and I/O errors fail closed as unknown.
 */
export async function resolvePacketCheckout(
  packet: OrchestratorPacket,
): Promise<PacketCheckoutResolution> {
  const paths = new Set<string>();
  const durablePath = packet.lane?.worktreePath?.trim();
  if (durablePath) paths.add(path.resolve(durablePath));

  try {
    for (const lane of listLanes()) {
      if (lane.packetId?.trim() !== packet.id) continue;
      const lanePath = lane.worktreePath?.trim();
      if (lanePath) paths.add(path.resolve(lanePath));
    }
  } catch (error) {
    return {
      state: 'unknown',
      evidence: `Lane checkout lookup failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (paths.size === 0) {
    return { state: 'absent', evidence: 'No durable lane or lane row names a checkout path.' };
  }

  const unknown: string[] = [];
  for (const worktreePath of paths) {
    try {
      await lstat(worktreePath);
      return { state: 'present', evidence: 'A recorded checkout path still exists.' };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') continue;
      unknown.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (unknown.length > 0) {
    return { state: 'unknown', evidence: `Checkout probes were inconclusive (${unknown.join('; ')}).` };
  }
  return { state: 'absent', evidence: `All ${paths.size} recorded checkout path(s) are absent.` };
}
