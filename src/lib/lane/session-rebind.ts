import { attachSession, getLane } from '@/lib/lane/registry';
import type { Lane, LaneEventActor } from '@/lib/lane/types';

export function rebindLaneSessionIfChanged(
  laneId: string,
  previousSessionKey: string | null | undefined,
  nextSessionKey: string | null | undefined,
  actor: LaneEventActor = 'system',
): Lane | null {
  const normalizedNext = nextSessionKey?.trim();
  if (!normalizedNext) return getLane(laneId);

  const normalizedPrevious = previousSessionKey?.trim() || null;
  if (normalizedPrevious === normalizedNext) return getLane(laneId);

  return attachSession(laneId, normalizedNext, actor);
}
