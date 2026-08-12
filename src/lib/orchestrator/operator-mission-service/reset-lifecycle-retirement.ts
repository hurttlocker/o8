import {
  archiveLaneSessions,
  assertLaneSessionsArchived,
  killLaneSessionsConfirmed,
  LaneSessionArchiveUnconfirmedError,
} from '@/lib/lane/reap-sessions';
import {
  ResetKillUnconfirmedError,
  ResetSessionArchiveUnconfirmedError,
} from './reset-errors';

export async function archiveResetLaneSessions(
  lanes: Parameters<typeof archiveLaneSessions>[0],
) {
  try {
    const result = await archiveLaneSessions(lanes);
    assertLaneSessionsArchived(result);
    return result;
  } catch (error) {
    if (error instanceof LaneSessionArchiveUnconfirmedError) {
      throw new ResetSessionArchiveUnconfirmedError(error.message);
    }
    throw error;
  }
}

export async function confirmedKilledLaneIds(
  lanes: Parameters<typeof killLaneSessionsConfirmed>[0],
) {
  const outcomes = await killLaneSessionsConfirmed(lanes);
  const survivors = outcomes.filter((outcome) => !outcome.confirmed && !outcome.alreadyDead);
  if (survivors.length > 0) {
    throw new ResetKillUnconfirmedError(
      `Reset could not confirm ${survivors.length} live worker${survivors.length === 1 ? '' : 's'} stopped; lane, session, and worktree bindings were preserved.`,
    );
  }
  return new Set(outcomes
    .filter((outcome) => outcome.confirmed || outcome.alreadyDead)
    .map((outcome) => outcome.laneId));
}
