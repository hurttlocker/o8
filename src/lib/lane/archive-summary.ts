import type { Lane, LaneEvent } from './types';

export interface LaneArchiveSummary {
  source: 'zombie_reaper' | 'user' | 'orchestrator' | 'system';
  message: string;
  preservedBranch?: string | null;
  /** Durable lane outcome, when stamped — lets banners label truthfully
   *  (Merged / Discarded / No changes) instead of a generic Archived. */
  outcome?: 'merged' | 'discarded' | 'no_changes' | null;
}

function stringField(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function latestEvent(events: LaneEvent[], predicate: (event: LaneEvent) => boolean): LaneEvent | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (predicate(event)) return event;
  }
  return null;
}

export function summarizeLaneArchive(
  lane: Pick<Lane, 'status' | 'outcome' | 'outcomeNote'>,
  events: LaneEvent[],
): LaneArchiveSummary | null {
  if (lane.status !== 'archived' && lane.status !== 'completed') return null;

  // The durable outcome outranks event archaeology — a lane that MERGED and
  // was then archived by post-merge cleanup must never read "archived
  // without merging" (live-hit 2026-07-18: the merged Seasonal-drink tab's
  // banner lied). Same truth for deliberate discards and no-commit finishes.
  if (lane.outcome === 'merged') {
    return { source: 'system', outcome: 'merged', message: lane.outcomeNote ?? 'Merged into main and archived.' };
  }
  if (lane.outcome === 'discarded') {
    return { source: 'user', outcome: 'discarded', message: lane.outcomeNote ?? 'Discarded by the operator.' };
  }
  if (lane.outcome === 'no_changes') {
    return { source: 'system', outcome: 'no_changes', message: lane.outcomeNote ?? 'Agent finished without making changes.' };
  }

  const zombie = latestEvent(events, (event) => event.verb === 'zombie_reap');
  if (zombie) {
    const preservedBranch = stringField(zombie.payload.preservedBranch);
    return {
      source: 'zombie_reaper',
      preservedBranch,
      message: preservedBranch
        ? `Archived by the zombie reaper after the session went silent - work preserved on ${preservedBranch}.`
        : 'Archived by the zombie reaper after the session went silent.',
    };
  }

  const archived = latestEvent(events, (event) => (
    event.verb === 'status_change' && event.payload.status === 'archived'
  ));
  if (!archived) return null;

  if (archived.actor === 'user') {
    return {
      source: 'user',
      message: 'Archived by the operator without merging.',
    };
  }
  if (archived.actor === 'orchestrator') {
    return {
      source: 'orchestrator',
      message: 'Archived by the orchestrator without merging.',
    };
  }
  return {
    source: 'system',
    message: 'Archived by the system without merging.',
  };
}
