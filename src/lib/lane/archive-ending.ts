import { enqueueInboxItem } from '@/lib/supervisor/inbox';
import type { Lane, LaneEvent, LaneOutcome } from './types';

export interface ArchiveEnding {
  updates: { outcome: LaneOutcome; outcomeNote: string | null };
  contractViolation: boolean;
}

function recordedQuestion(events: LaneEvent[]): string | null {
  return events
    .map((event) => event.payload.question ?? event.payload.reason)
    .find((value): value is string => typeof value === 'string' && Boolean(value.trim()))
    ?.trim() ?? null;
}

export function resolveArchiveEnding(lane: Lane, events: LaneEvent[]): ArchiveEnding {
  if (lane.outcome) {
    return {
      updates: { outcome: lane.outcome, outcomeNote: lane.outcomeNote ?? null },
      contractViolation: false,
    };
  }

  if (lane.status === 'awaiting_human') {
    return {
      updates: {
        outcome: 'asked',
        outcomeNote: recordedQuestion(events)
          ?? `What should happen next for lane "${lane.label}" in ${lane.repoPath}?`,
      },
      contractViolation: false,
    };
  }

  return {
    updates: { outcome: 'no_changes', outcomeNote: 'Archived without a recorded ending' },
    contractViolation: true,
  };
}

export function reportMissingArchiveEnding(lane: Lane): void {
  enqueueInboxItem({
    repoPath: lane.repoPath,
    packetId: lane.packetId,
    kind: 'packet_no_changes',
    status: 'human_required',
    payload: {
      laneId: lane.id,
      laneLabel: lane.label,
      repoPath: lane.repoPath,
      outcome: 'no_changes',
      note: 'Archived without a recorded ending',
    },
  });
}
