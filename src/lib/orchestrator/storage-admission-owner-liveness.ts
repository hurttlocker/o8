import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';

import { listLanes } from '@/lib/lane/registry';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import { managedPacketWorktreeId } from '@/lib/worktree/root-layout';

export interface PacketCheckoutResolution {
  state: 'present' | 'absent' | 'unknown';
  evidence: string;
}

async function probeRecordedCheckoutPaths(paths: Set<string>): Promise<PacketCheckoutResolution> {
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
  return unknown.length > 0
    ? { state: 'unknown', evidence: `Checkout probes were inconclusive (${unknown.join('; ')}).` }
    : { state: 'absent', evidence: `All ${paths.size} recorded checkout path(s) are absent.` };
}

async function probeReservationTarget(
  ownerId: string,
  targetPath: string,
): Promise<PacketCheckoutResolution> {
  const worktreeId = managedPacketWorktreeId(ownerId);
  if (!worktreeId) {
    return { state: 'unknown', evidence: 'The packet owner cannot be mapped to a managed checkout id.' };
  }
  const normalizedTarget = path.resolve(targetPath);
  const targetName = path.basename(normalizedTarget);
  if (targetName === worktreeId || targetName.startsWith(`${worktreeId}-`)) {
    return probeRecordedCheckoutPaths(new Set([normalizedTarget]));
  }
  try {
    const target = await lstat(normalizedTarget);
    if (target.isSymbolicLink() || !target.isDirectory()) {
      return { state: 'unknown', evidence: 'The admitted checkout root is not a stable directory.' };
    }
    const entries = await readdir(normalizedTarget);
    const present = entries.some((entry) => (
      entry === worktreeId || entry.startsWith(`${worktreeId}-`)
    ));
    return present
      ? { state: 'present', evidence: 'A packet-named checkout still exists under the admitted root.' }
      : { state: 'absent', evidence: 'No packet-named checkout exists under the admitted root.' };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { state: 'absent', evidence: 'The admitted checkout root is absent.' };
    }
    return {
      state: 'unknown',
      evidence: `The admitted checkout root could not be inspected (${error instanceof Error ? error.message : String(error)}).`,
    };
  }
}

/**
 * Prove packet checkout absence from recorded paths and the admitted root.
 * Either source can retain the row; both must agree on absence before release.
 */
export async function resolvePacketCheckoutByOwner(input: {
  ownerId: string;
  recordedPaths?: Array<string | null | undefined>;
  reservationTargetPath?: string | null;
}): Promise<PacketCheckoutResolution> {
  const paths = new Set(input.recordedPaths
    ?.map((candidate) => candidate?.trim())
    .filter((candidate): candidate is string => Boolean(candidate))
    .map((candidate) => path.resolve(candidate)) ?? []);
  const recorded = await probeRecordedCheckoutPaths(paths);
  if (recorded.state !== 'absent') return recorded;
  const reservationTargetPath = input.reservationTargetPath?.trim();
  if (!reservationTargetPath) {
    return paths.size === 0
      ? { state: 'absent', evidence: 'No durable lane or lane row names a checkout path.' }
      : recorded;
  }
  return probeReservationTarget(input.ownerId, reservationTargetPath);
}

/**
 * Resolve checkout ownership from both durable packet binding and the lane
 * ledger. Absence is affirmative only when every recorded path returns
 * ENOENT/ENOTDIR; permission and I/O errors fail closed as unknown.
 */
export async function resolvePacketCheckout(
  packet: OrchestratorPacket,
  options: { reservationTargetPath?: string | null } = {},
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

  return resolvePacketCheckoutByOwner({
    ownerId: packet.id,
    recordedPaths: [...paths],
    reservationTargetPath: options.reservationTargetPath,
  });
}
