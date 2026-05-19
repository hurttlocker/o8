import 'server-only';

import { listActiveLanes } from '@/lib/lane/registry';
import type { LaneStatus } from '@/lib/lane/types';
import { getProjectContext } from '@/lib/projects/context';

const STALE_LOCK_MS = 5 * 60_000;

export interface ProjectLock {
  projectId: string;
  runtimeProjectId: string;
  projectName: string;
  repoId: string | null;
  repoName: string;
  repoPath: string;
  laneId: string;
  packetId: string | null;
  label: string;
  status: LaneStatus;
  runtime: string;
  branch: string;
  lastHeartbeatAt: number | null;
  lastEventAt: string | null;
  stale: boolean;
}

function isStale(lastHeartbeatAt: number | null, lastEventAt: string | null) {
  const now = Date.now();
  if (typeof lastHeartbeatAt === 'number' && lastHeartbeatAt > 0) {
    return now - lastHeartbeatAt > STALE_LOCK_MS;
  }
  const eventMs = lastEventAt ? Date.parse(lastEventAt) : Number.NaN;
  return Number.isFinite(eventMs) ? now - eventMs > STALE_LOCK_MS : false;
}

export async function listProjectLocks(projectId?: string | null): Promise<ProjectLock[]> {
  const filter = projectId?.trim().toLowerCase() || null;
  const lanes = listActiveLanes();
  const locks: ProjectLock[] = [];

  for (const lane of lanes) {
    const context = await getProjectContext({
      repoPath: lane.repoPath,
      projectId: lane.projectId,
    });
    const matchesFilter = !filter
      || context.id.toLowerCase() === filter
      || context.runtimeProjectId.toLowerCase() === filter
      || context.slug.toLowerCase() === filter;
    if (!matchesFilter) continue;

    const repo = context.repos.find((candidate) => candidate.localPath === lane.repoPath)
      ?? context.primaryRepo
      ?? null;

    locks.push({
      projectId: context.id,
      runtimeProjectId: context.runtimeProjectId,
      projectName: context.name,
      repoId: repo?.id ?? null,
      repoName: repo?.name ?? lane.repoPath.split('/').filter(Boolean).at(-1) ?? lane.repoPath,
      repoPath: lane.repoPath,
      laneId: lane.id,
      packetId: lane.packetId,
      label: lane.label,
      status: lane.status,
      runtime: lane.runtime,
      branch: lane.branch,
      lastHeartbeatAt: lane.lastHeartbeatAt,
      lastEventAt: lane.lastEventAt,
      stale: isStale(lane.lastHeartbeatAt, lane.lastEventAt),
    });
  }

  return locks.sort((left, right) => {
    if (left.stale !== right.stale) return left.stale ? -1 : 1;
    return (right.lastHeartbeatAt ?? 0) - (left.lastHeartbeatAt ?? 0);
  });
}
