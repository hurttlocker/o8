import type { Lane, LaneEvent } from './types';

export interface LaneArchiveSummary {
  source: 'zombie_reaper' | 'user' | 'orchestrator' | 'system';
  message: string;
  preservedBranch?: string | null;
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
  lane: Pick<Lane, 'status'>,
  events: LaneEvent[],
): LaneArchiveSummary | null {
  if (lane.status !== 'archived' && lane.status !== 'completed') return null;

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
