import path from 'node:path';

import type { LaneRuntime } from './types';
import { findLaneByRepoAndBranch } from './registry';
import { readPinnedLaneCreationBaseCommit } from './creation-base';

export interface PacketCreationBaseAuthority {
  repoPath: string;
  packetId: string;
  branch: string;
  baseBranch: string;
  baseCommit: string;
}

export type PacketCreationBaseInput = Omit<PacketCreationBaseAuthority, 'baseCommit'> & { runtime: LaneRuntime };

export class PacketCreationBaseError extends Error {
  readonly reason = 'fetch_unreachable';
}

export function assertPacketCreationBaseAuthority(
  authority: PacketCreationBaseAuthority,
  input: Omit<PacketCreationBaseAuthority, 'baseCommit'>,
): void {
  if (path.resolve(authority.repoPath) !== path.resolve(input.repoPath)
    || authority.packetId !== input.packetId || authority.branch !== input.branch
    || authority.baseBranch !== input.baseBranch
    || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(authority.baseCommit)) {
    throw new Error('Packet creation base authority does not match this launch.');
  }
}

/** Existing branch lanes are reused by open_lane, so their persisted base wins over current refs. */
export function existingPacketCreationBase(input: PacketCreationBaseInput): PacketCreationBaseAuthority | null {
  const lane = findLaneByRepoAndBranch(input.repoPath, input.branch);
  if (!lane) return null;
  const baseCommit = readPinnedLaneCreationBaseCommit(lane.id);
  if (!baseCommit) throw new Error('Existing packet lane has no immutable creation base receipt.');
  return Object.freeze({
    repoPath: path.resolve(input.repoPath), packetId: input.packetId,
    branch: input.branch, baseBranch: lane.baseBranch, baseCommit,
  });
}

/** Resolve once without creating a lane; retain the command bus's fetch recovery and cooldown. */
export async function resolvePacketCreationBase(input: PacketCreationBaseInput): Promise<PacketCreationBaseAuthority> {
  const existing = existingPacketCreationBase(input);
  if (existing) return existing;
  const [{ getWorktreeManager, WorktreeFetchUnreachableError }, fetchRecovery] = await Promise.all([
    import('@/lib/worktree'), import('@/lib/runtime/fetch-unreachable-recovery'),
  ]);
  const retryInSeconds = fetchRecovery.fetchUnreachableCooldownRetrySeconds(input.repoPath, {
    packetId: input.packetId, stage: 'pre_lane_receipt',
  });
  if (retryInSeconds != null) {
    throw new PacketCreationBaseError(`Launch blocked: fetch_unreachable cooldown for ${input.repoPath}; retry in ${retryInSeconds}s`);
  }
  let baseCommit: string;
  try {
    baseCommit = await getWorktreeManager(input.repoPath).resolveCreationBaseCommit(input.baseBranch, input.branch);
    fetchRecovery.recordFetchUnreachableRecoverySuccess(input.repoPath);
  } catch (error) {
    if (!(error instanceof WorktreeFetchUnreachableError)) throw error;
    const recovery = fetchRecovery.recoverWorktreeFetchUnreachable({
      error, repoPath: input.repoPath, packetId: input.packetId, laneId: null,
      runtime: input.runtime, stage: 'pre_lane_receipt',
    });
    throw new PacketCreationBaseError(recovery.note);
  }
  const authority = { repoPath: path.resolve(input.repoPath), packetId: input.packetId,
    branch: input.branch, baseBranch: input.baseBranch, baseCommit };
  assertPacketCreationBaseAuthority(authority, input);
  return Object.freeze(authority);
}
