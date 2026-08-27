import { execFileSync } from 'node:child_process';

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
}): string | null {
  return gitObject(input.repoPath, ['merge-base', input.branch, input.baseBranch])
    ?? gitObject(input.repoPath, ['rev-parse', '--verify', `${input.baseBranch}^{commit}`]);
}

/** Read the append-only creation receipt. Legacy lanes legitimately return null. */
export function laneCreationBaseCommit(events: LaneEvent[]): string | null {
  const value = events.find((event) => event.verb === 'open_lane')?.payload.baseCommit;
  return typeof value === 'string' && OBJECT_ID_PATTERN.test(value) ? value : null;
}
