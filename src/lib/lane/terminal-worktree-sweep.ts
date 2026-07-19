import { readdir } from 'node:fs/promises';
import path from 'node:path';

import { listLanes } from './registry';
import type { Lane } from './types';
import { cleanupLaneWorktree } from './worktree-cleanup';
import { removeCortexWorktreePath } from './worktree-clone-removal';
import { resolveWorktreeRootLayout } from '@/lib/worktree/root-layout';

const CONTEXT_WORKTREE_DIR_NAME = 'context';
const PACKET_WORKTREE_PREFIX = 'packet-';

export interface TerminalWorktreeSweepResult {
  scanned: number;
  removed: number;
  skippedActive: number;
  failed: number;
}

function normalizePath(value: string) {
  return path.resolve(value).replace(/\/+$/, '');
}

function isCleanupTerminalStatus(status: Lane['status']) {
  return status === 'completed' || status === 'archived';
}

function packetDirName(packetId: string | null) {
  const packetSlug = packetId
    ?.trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
  return packetSlug ? `packet-${packetSlug}` : null;
}

function laneForWorktreeDir(
  dirPath: string,
  dirName: string,
  lanesByPath: Map<string, Lane>,
  lanesByPacketDir: Map<string, Lane>,
) {
  return lanesByPath.get(normalizePath(dirPath)) ?? lanesByPacketDir.get(dirName) ?? null;
}

export async function sweepTerminalCortexWorktrees(repoPath: string): Promise<TerminalWorktreeSweepResult> {
  const repoRoot = path.resolve(repoPath);
  const worktreeRoots = resolveWorktreeRootLayout(repoRoot).bases;
  const normalizedWorktreeRoots = worktreeRoots.map(normalizePath);
  const lanes = listLanes().filter((lane) => (
    normalizePath(lane.repoPath) === repoRoot
    || (lane.worktreePath
      ? normalizedWorktreeRoots.some((root) => normalizePath(lane.worktreePath!).startsWith(`${root}/`))
      : false)
  ));
  const lanesByPath = new Map<string, Lane>();
  const lanesByPacketDir = new Map<string, Lane>();

  for (const lane of lanes) {
    if (lane.worktreePath) {
      lanesByPath.set(normalizePath(lane.worktreePath), lane);
    }
    const dirName = packetDirName(lane.packetId);
    if (dirName) {
      lanesByPacketDir.set(dirName, lane);
    }
  }

  const result: TerminalWorktreeSweepResult = {
    scanned: 0,
    removed: 0,
    skippedActive: 0,
    failed: 0,
  };

  for (const worktreeRoot of worktreeRoots) {
    const entries = await readdir(worktreeRoot, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === CONTEXT_WORKTREE_DIR_NAME) continue;
      if (entry.name.startsWith('.')) continue;
      if (!entry.name.startsWith(PACKET_WORKTREE_PREFIX)) continue;
      result.scanned += 1;

      const dirPath = path.join(worktreeRoot, entry.name);
      const lane = laneForWorktreeDir(dirPath, entry.name, lanesByPath, lanesByPacketDir);
      if (lane && !isCleanupTerminalStatus(lane.status)) {
        result.skippedActive += 1;
        continue;
      }

      const removed = lane
        ? await cleanupLaneWorktree({ ...lane, worktreePath: dirPath }, { terminal: true })
        : await removeCortexWorktreePath({
          repoRoot,
          worktreePath: dirPath,
          logPrefix: 'terminal-worktree-sweep',
        });

      if (removed) {
        result.removed += 1;
      } else {
        result.failed += 1;
      }
    }
  }

  return result;
}
