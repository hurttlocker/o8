import { randomUUID } from 'node:crypto';

import { getDb, laneEvents } from '@/lib/db';
import type { LaneEvent, LaneEventActor, LaneEventVerb } from './types';

function nowIso() {
  return new Date().toISOString();
}

function generateEventId(): string {
  return `evt-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;
}

function getLaneEventDb() {
  const db = getDb();
  if (!db) {
    throw new Error('[lane-events] SQLite database is unavailable');
  }
  return db;
}

export function recordLaneEvent(
  laneId: string,
  verb: LaneEventVerb,
  actor: LaneEventActor,
  payload: Record<string, unknown> = {},
): LaneEvent {
  const event: LaneEvent = {
    id: generateEventId(),
    laneId,
    verb,
    actor,
    payload,
    timestamp: nowIso(),
  };

  getLaneEventDb().insert(laneEvents).values({
    id: event.id,
    laneId: event.laneId,
    verb: event.verb,
    actor: event.actor,
    payloadJson: JSON.stringify(event.payload),
    timestamp: event.timestamp,
  }).run();

  return event;
}

export function recordMergeCleanupEvent(
  laneId: string,
  payload: {
    branch_deleted: boolean;
    worktree_removed: boolean;
    session_archived: boolean;
  },
) {
  return recordLaneEvent(laneId, 'merge_cleanup', 'system', payload);
}
