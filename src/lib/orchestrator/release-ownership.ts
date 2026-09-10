import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { getSqlite } from '@/lib/db';
import { findLatestLaneByPacket } from '@/lib/lane/registry';
import type { Lane } from '@/lib/lane/types';
import type { OrchestratorPacket } from './types';

const execFileAsync = promisify(execFile);

export function packetReleaseGeneration(packet: OrchestratorPacket, laneId: string): string {
  const turn = getSqlite().prepare(`SELECT id FROM lane_events WHERE lane_id = ?
    AND verb IN ('steered_packet', 'steer_run_admitted', 'steer_failed', 'launch_requested') ORDER BY rowid DESC LIMIT 1`)
    .get(laneId) as { id: string } | undefined;
  return JSON.stringify([packet.id, packet.lane?.laneId ?? laneId, packet.attemptCount ?? 0,
    packet.storageAdmissionEpoch ?? 0, packet.workspaceTargetPath, packet.branchTarget, turn?.id ?? null]);
}

export function packetReleaseIdentityIsCurrent(packet: OrchestratorPacket, laneId: string, generation: string, allowReleased = false): boolean {
  if (packet.operatorStopped || packet.archivedAt || packet.status === 'archived'
    || (!allowReleased && packet.releaseState === 'released')) return false;
  const binding = packet.lane?.laneId ?? findLatestLaneByPacket(packet.id)?.id;
  return binding === laneId && packetReleaseGeneration(packet, laneId) === generation;
}

async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd, windowsHide: true, timeout: 2_000, maxBuffer: 512 * 1024 });
    return stdout.trim();
  } catch { return null; }
}

/** Recheck the actual checkout, including detached HEAD and uncommitted work. */
export async function verifyCurrentLaneHead(lane: Lane, headSha: string): Promise<boolean> {
  const worktree = lane.worktreePath && existsSync(lane.worktreePath) ? lane.worktreePath : null;
  const cwd = worktree || lane.repoPath, ref = worktree ? 'HEAD' : lane.branch;
  if (!ref || !headSha) return false;
  if (await git(cwd, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]) !== headSha) return false;
  if (worktree && await git(worktree, ['status', '--porcelain', '--untracked-files=normal']) !== '') return false;
  return await git(cwd, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]) === headSha;
}
