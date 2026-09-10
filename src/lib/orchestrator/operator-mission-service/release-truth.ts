import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import type { Lane } from '@/lib/lane/types';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import { hasCanonicalReleaseEvidence } from '@/lib/orchestrator/packet-release-truth';
import type { MergePacketResult } from './types';

interface ReleaseLane {
  id?: string;
  repoPath: string;
  branch?: string | null;
  baseBranch?: string | null;
  worktreePath?: string | null;
  status?: Lane['status'];
}

const execFileAsync = promisify(execFile);
const loadControlPlane = () => import('@/lib/orchestrator/control-plane');
const loadMergeTruth = () => import('./merge-truth');
const loadLaneRegistry = () => import('@/lib/lane/registry');

async function gitValue(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd, windowsHide: true, timeout: 5_000, maxBuffer: 512 * 1024,
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

function readCommit(cwd: string, ref: string): Promise<string | null> {
  return gitValue(cwd, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]);
}

/** A release belongs to its target branch, not the checkout's incidental HEAD. */
async function verifyCurrentRelease(
  lane: ReleaseLane,
  mergeSha: string,
  recordedHead: string | null,
  acceptsRecordedMerge: boolean,
): Promise<string | null> {
  const base = lane.baseBranch?.trim() || 'main';
  if (base === 'HEAD') return null;
  const baseRef = base.startsWith('refs/') ? base : `refs/heads/${base}`;
  const baseSha = await readCommit(lane.repoPath, baseRef)
    ?? await readCommit(lane.repoPath, `refs/remotes/origin/${base}`);
  if (!baseSha) return null;
  const { isAncestorCommit } = await loadMergeTruth();
  if (!(await isAncestorCommit(lane.repoPath, mergeSha, baseSha))) return null;

  const worktree = lane.worktreePath && existsSync(lane.worktreePath) ? lane.worktreePath : null;
  const currentHead = worktree
    ? await readCommit(worktree, 'HEAD')
    : lane.branch ? await readCommit(lane.repoPath, lane.branch) : null;
  if (worktree && await gitValue(worktree, ['status', '--porcelain', '--untracked-files=normal']) !== '') return null;

  if (!currentHead) {
    // A completed merge may have already cleaned up both the branch and worktree.
    // Only its explicit, HEAD-pinned receipt can survive that missing Git state.
    return !worktree && acceptsRecordedMerge && recordedHead
      && (lane.status === 'completed' || lane.status === 'archived')
      ? baseSha : null;
  }
  if (recordedHead && currentHead !== recordedHead) return null;
  const landed = acceptsRecordedMerge && recordedHead === currentHead
    || await isAncestorCommit(lane.repoPath, currentHead, baseSha);
  if (!landed) return null;
  // Refuse evidence that moved while the Git probes were in flight.
  const finalHead = await readCommit(worktree || lane.repoPath, worktree ? 'HEAD' : lane.branch!);
  return finalHead === currentHead ? baseSha : null;
}

export function buildAlreadyReleasedResult(mergeSha: string): MergePacketResult {
  return {
    merged: true,
    note: 'Already released (via auto-merge)',
    alreadyReleased: true,
    mergeSha,
    ancestryVerified: true,
  };
}

function isAlreadyReleasedPacket(packet: OrchestratorPacket | null | undefined) {
  return packet?.releaseState === 'released';
}

function claimIdentity(packet: OrchestratorPacket): string {
  const receipt = packet.releaseStatePayload;
  return JSON.stringify([
    receipt?.source ?? null, receipt?.mergeCommit ?? null, receipt?.headSha ?? null,
    receipt?.evidenceKind ?? null, receipt?.releasedAt ?? null,
    packet.releaseState, packet.lane?.laneId ?? null, packet.attemptCount ?? 0,
    packet.storageAdmissionEpoch ?? 0, packet.workspaceTargetPath, packet.branchTarget,
    Boolean(packet.operatorStopped), packet.archivedAt ?? null,
  ]);
}

async function claimStillCurrent(packetId: string, expected: OrchestratorPacket | undefined): Promise<boolean> {
  const { readOrchestratorControlPlaneState } = await loadControlPlane();
  const current = readOrchestratorControlPlaneState().packets.find((packet) => packet.id === packetId);
  return expected && current ? claimIdentity(expected) === claimIdentity(current) : !expected && !current;
}

async function clearStaleReleaseClaim(expected: OrchestratorPacket, reason: string) {
  const { withLockedState } = await loadControlPlane();
  await withLockedState((state) => {
    const packet = state.packets.find((candidate) => candidate.id === expected.id);
    if (!packet || !isAlreadyReleasedPacket(packet) || claimIdentity(packet) !== claimIdentity(expected)) return;
    packet.releaseState = 'pending';
    if (packet.status === 'released') packet.status = 'awaiting_review';
    packet.releaseStatePayload = { ...(packet.releaseStatePayload ?? {}), source: reason };
  });
}

export async function alreadyReleasedResultForPacket(
  packet: OrchestratorPacket | null | undefined,
  lane: ReleaseLane | null | undefined,
): Promise<MergePacketResult | null> {
  if (!packet || !isAlreadyReleasedPacket(packet)) return null;
  // A receipt from another bound lane cannot answer for this packet generation.
  if (packet.lane?.laneId && packet.lane.laneId !== lane?.id) return null;
  const payload = packet.releaseStatePayload;
  const mergeSha = payload?.mergeCommit?.trim();
  const recordedHead = payload?.headSha?.trim() || null;
  const acceptsRecordedMerge = hasCanonicalReleaseEvidence(packet)
    && ['merge_command', 'patch-id', 'pull_request_merged'].includes(payload?.evidenceKind ?? '');
  if (mergeSha && lane?.repoPath && await verifyCurrentRelease(lane, mergeSha, recordedHead, acceptsRecordedMerge)) {
    return await claimStillCurrent(packet.id, packet) ? buildAlreadyReleasedResult(mergeSha) : null;
  }
  await clearStaleReleaseClaim(packet, 'stale_release_flag_current_work_unproved');
  return null;
}

/** Terminal status is only a candidate for Git verification, never release proof. */
export async function isTerminalReleaseLane(packetId: string): Promise<boolean> {
  const { findLatestLaneByPacket, getLaneEvents } = await loadLaneRegistry();
  const lane = findLatestLaneByPacket(packetId);
  if (!lane) return false;
  return lane.status === 'completed' || (lane.status === 'archived' && getLaneEvents(lane.id).some(
    (event) => event.verb === 'status_change' && event.payload.status === 'completed',
  ));
}

export async function alreadyReleasedResultForPacketId(packetId: string, packets: OrchestratorPacket[]) {
  const { findLatestLaneByPacket, getLane, getLaneEvents } = await loadLaneRegistry();
  const { readOrchestratorControlPlaneState } = await loadControlPlane();
  // Read-time reconciliation intentionally hides released lane bindings. Use
  // the durable binding for generation identity, not that UI projection.
  const packet = readOrchestratorControlPlaneState().packets.find((candidate) => candidate.id === packetId)
    ?? packets.find((candidate) => candidate.id === packetId);
  const lane = packet?.lane?.laneId ? getLane(packet.lane.laneId) : findLatestLaneByPacket(packetId);
  const packetResult = await alreadyReleasedResultForPacket(packet, lane);
  if (packetResult) return packetResult;
  // A rejected receipt must not be resurrected by an older lane-completion event.
  if (packet?.releaseState === 'released' || packet?.operatorStopped || packet?.archivedAt) return null;
  if (!lane?.repoPath || !['completed', 'archived'].includes(lane.status)) return null;
  const laneHeadSha = getLaneEvents(lane.id).slice().reverse()
    .filter((event) => event.verb === 'merge')
    .map((event) => event.payload.laneHeadSha)
    .find((sha): sha is string => typeof sha === 'string' && sha.trim().length > 0)?.trim();
  if (!laneHeadSha) return null;
  const baseSha = await verifyCurrentRelease(lane, laneHeadSha, laneHeadSha, true);
  return baseSha && await claimStillCurrent(packetId, packet) ? buildAlreadyReleasedResult(baseSha) : null;
}
