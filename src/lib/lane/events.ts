import { randomUUID } from 'node:crypto';

import { getDb, getSqlite, laneEvents } from '@/lib/db';
import type { LaneEvent, LaneEventActor, LaneEventVerb } from './types';
import { publishPacketTailEvent } from './packet-tail';

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

function createLaneEvent(
  laneId: string,
  verb: LaneEventVerb,
  actor: LaneEventActor,
  payload: Record<string, unknown>,
): LaneEvent {
  return { id: generateEventId(), laneId, verb, actor, payload, timestamp: nowIso() };
}

function insertLaneEvent(event: LaneEvent): void {
  getLaneEventDb().insert(laneEvents).values({
    id: event.id,
    laneId: event.laneId,
    verb: event.verb,
    actor: event.actor,
    payloadJson: JSON.stringify(event.payload),
    timestamp: event.timestamp,
  }).run();
}

export function recordLaneEvent(
  laneId: string,
  verb: LaneEventVerb,
  actor: LaneEventActor,
  payload: Record<string, unknown> = {},
): LaneEvent {
  const event = createLaneEvent(laneId, verb, actor, payload);
  insertLaneEvent(event);

  publishPacketTailEvent(event);
  return event;
}

/** Persist a cross-lane audit seam all-or-nothing before publishing it live. */
export function recordLaneEventsAtomic(inputs: Array<{
  laneId: string;
  verb: LaneEventVerb;
  actor: LaneEventActor;
  payload?: Record<string, unknown>;
}>): LaneEvent[] {
  const events = inputs.map((input) => createLaneEvent(
    input.laneId,
    input.verb,
    input.actor,
    input.payload ?? {},
  ));
  getSqlite().transaction(() => {
    for (const event of events) insertLaneEvent(event);
  })();
  for (const event of events) {
    try {
      publishPacketTailEvent(event);
    } catch (error) {
      console.warn('[lane-events] persisted event publication failed:', error);
    }
  }
  return events;
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
