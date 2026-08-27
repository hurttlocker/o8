import { resolvePacketAttributionBase } from '@/lib/diff/base-resolution';
import { readLaneCreationBaseCommit } from '@/lib/lane/creation-base';
import type { Lane } from '@/lib/lane/types';

/** Resolve the append-only creation baseline used to attribute work to one lane. */
export function resolveLaneAttributionBase(
  lane: Pick<Lane, 'id' | 'baseBranch'>,
  cwd: string,
  headSha: string,
) {
  return resolvePacketAttributionBase(
    cwd,
    lane.baseBranch || 'main',
    headSha,
    readLaneCreationBaseCommit(lane.id),
  );
}
