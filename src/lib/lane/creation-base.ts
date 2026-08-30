import { execFileSync } from 'node:child_process';
import { and, asc, eq } from 'drizzle-orm';

import { getDb, laneEvents } from '@/lib/db';
import type { LaneEvent } from './types';

const OBJECT_ID_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

function gitObject(cwd: string, args: string[]): string | null {
  try {
    const value = execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 3_000,
    }).trim();
    return OBJECT_ID_PATTERN.test(value) ? value : null;
  } catch {
    return null;
  }
}

/** Resolve the commit shared by the packet branch and its base when the lane opens. */
export function resolveLaneCreationBaseCommit(input: {
  repoPath: string;
  branch: string;
  baseBranch: string;
  baseCommit?: string | null;
}): string | null {
  const pinnedBase = input.baseCommit?.trim().toLowerCase() ?? '';
  if (pinnedBase) {
    if (!OBJECT_ID_PATTERN.test(pinnedBase)) {
      throw new Error('Resolved lane creation base is not a full Git object ID.');
    }
    return pinnedBase;
  }
  return gitObject(input.repoPath, ['merge-base', input.branch, input.baseBranch])
    ?? gitObject(input.repoPath, ['rev-parse', '--verify', `${input.baseBranch}^{commit}`]);
}

/** Read the append-only creation receipt. Legacy lanes legitimately return null. */
export function laneCreationBaseCommit(events: LaneEvent[]): string | null {
  const value = events.find((event) => event.verb === 'open_lane')?.payload.baseCommit;
  return typeof value === 'string' && OBJECT_ID_PATTERN.test(value) ? value : null;
}

/** Read a lane's creation base without coupling review paths to the lane registry. */
export function readLaneCreationBaseCommit(laneId: string): string | null {
  const payload = readLaneCreationReceipt(laneId);
  const value = payload?.baseCommit;
  return typeof value === 'string' && OBJECT_ID_PATTERN.test(value) ? value : null;
}

/** Read the exact base that managed packet provisioning must start from. */
export function readPinnedLaneCreationBaseCommit(laneId: string): string | null {
  const payload = readLaneCreationReceipt(laneId);
  if (payload?.baseCommitPinned !== true) return null;
  const value = payload.baseCommit;
  return typeof value === 'string' && OBJECT_ID_PATTERN.test(value) ? value : null;
}

function readLaneCreationReceipt(laneId: string): Record<string, unknown> | null {
  const db = getDb();
  if (!db) return null;
  const row = db
    .select({ payloadJson: laneEvents.payloadJson })
    .from(laneEvents)
    .where(and(eq(laneEvents.laneId, laneId), eq(laneEvents.verb, 'open_lane')))
    .orderBy(asc(laneEvents.timestamp))
    .limit(1)
    .get();
  if (!row) return null;
  try {
    return JSON.parse(row.payloadJson) as Record<string, unknown>;
  } catch {
    return null;
  }
}
