import path from 'node:path';
import { getSqlite } from '@/lib/db';
import { getLane } from './registry';
import type { Lane } from './types';
import type { WorktreeMetaEntry } from '@/lib/worktree/types';
import { canonicalRepoRoot, isManagedPacketWorktreeId } from '@/lib/worktree/root-layout';
import { ensureMaintenanceDiscoverySchema, WORKTREE_LANE_BASENAME_SQL } from '@/lib/worktree/maintenance-discovery';

const MAX_EXACT_OWNERS = 32;

function boundedLanes(sql: string, parameters: string[]): Lane[] {
  ensureMaintenanceDiscoverySchema();
  const rows = getSqlite().prepare(sql).all(...parameters, MAX_EXACT_OWNERS + 1) as Array<{ id: string }>;
  if (rows.length > MAX_EXACT_OWNERS) throw new Error('Exact workspace lane authority exceeds the bounded owner policy.');
  return rows.flatMap((row) => { const lane = getLane(row.id); return lane ? [lane] : []; });
}

function indexedWorkspaceLaneCandidates(source: string, canonicalSource: string, worktreeId: string): Lane[] {
  // A resolved exact path retains its final component unless its raw name ends
  // in '.' or '..'. Include those ambiguous tails, then normalize the bounded rows.
  return boundedLanes(`SELECT id FROM lanes INDEXED BY idx_maintenance_lane_basename
    WHERE ${WORKTREE_LANE_BASENAME_SQL} IN (?, ?, ?, '.', '..') AND worktree_path IS NOT NULL LIMIT ?`,
  [worktreeId, path.basename(source), path.basename(canonicalSource)]);
}

/** Exact indexed ownership queries preserve ambiguity refusal without loading lane history. */
export function exactWorkspaceOwningLanes(
  repositoryPath: string, sourcePath: string, metadata?: WorktreeMetaEntry,
): Lane[] {
  const source = path.resolve(sourcePath);
  const canonicalSource = metadata?.materializationIdentity?.canonicalPath ?? canonicalRepoRoot(source);
  const lanes = indexedWorkspaceLaneCandidates(source, canonicalSource, path.basename(source))
    .filter((lane) => lane.worktreePath !== null
      && [source, canonicalSource].includes(path.resolve(lane.worktreePath))
      && canonicalRepoRoot(lane.repoPath) === canonicalRepoRoot(repositoryPath));
  if (metadata?.laneId && metadata.packetId && metadata.sessionKey
    && metadata.materializationIdentity?.canonicalPath === source
    && isManagedPacketWorktreeId(path.basename(source), metadata.packetId)) {
    const lane = getLane(metadata.laneId);
    if (lane && lane.worktreePath === null && lane.packetId === metadata.packetId
      && lane.sessionKey === metadata.sessionKey
      && (lane.status === 'completed' || lane.status === 'archived')
      && canonicalRepoRoot(lane.repoPath) === canonicalRepoRoot(repositoryPath)) lanes.push(lane);
  }
  return lanes;
}

/** A basename collision in the same repo is also ownership, even at an older namespace. */
export function hasStandaloneWorkspaceLane(repositoryPath: string, sourcePath: string, worktreeId: string): boolean {
  const source = path.resolve(sourcePath);
  const canonicalSource = canonicalRepoRoot(source);
  return indexedWorkspaceLaneCandidates(source, canonicalSource, worktreeId).some((lane) => {
    if (!lane.worktreePath) return false;
    if ([source, canonicalSource].includes(path.resolve(lane.worktreePath))) return true;
    return path.basename(lane.worktreePath) === worktreeId
      && canonicalRepoRoot(lane.repoPath) === canonicalRepoRoot(repositoryPath);
  });
}
