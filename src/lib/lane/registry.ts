import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, isNotNull, ne, notInArray } from 'drizzle-orm';
import { expireStaleApprovals } from '@/lib/approvals/store';
import { getDb, getSqlite, laneEvents, lanes } from '@/lib/db';
import { publishRealtimeMutation } from '@/lib/realtime/publisher';
import type { LaneLifecycleEventPayload } from '@/lib/realtime/types';
import type {
  Lane,
  LaneEvent,
  LaneEventActor,
  LaneOwnership,
  LaneRuntime,
  LaneStatus,
} from './types';

type LaneRow = typeof lanes.$inferSelect;
type LaneEventRow = typeof laneEvents.$inferSelect;

function nowIso() {
  return new Date().toISOString();
}

function generateLaneId(): string {
  return `lane-${randomUUID().slice(0, 12)}`;
}

function generateEventId(): string {
  return `evt-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;
}

function getLaneDb() {
  const db = getDb();
  if (!db) {
    throw new Error('[lane-registry] SQLite database is unavailable');
  }
  return db;
}

function generateLaneLifecycleMutationId(laneId: string) {
  return `lane-lifecycle-${laneId}-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;
}

function buildLaneLifecyclePayload(
  lane: Pick<Lane, 'id' | 'packetId' | 'status' | 'sessionKey' | 'branch' | 'repoPath'>,
  previousStatus: LaneStatus | null,
  timestamp: string,
): LaneLifecycleEventPayload {
  return {
    laneId: lane.id,
    packetId: lane.packetId,
    status: lane.status,
    previousStatus,
    sessionKey: lane.sessionKey,
    branch: lane.branch,
    repoPath: lane.repoPath,
    timestamp,
  };
}

function publishLaneLifecycleEvent(
  lane: Pick<Lane, 'id' | 'packetId' | 'status' | 'sessionKey' | 'branch' | 'repoPath' | 'runtime' | 'label'>,
  previousStatus: LaneStatus | null,
  timestamp: string,
) {
  const payload = buildLaneLifecyclePayload(lane, previousStatus, timestamp);
  console.log(`[lane-lifecycle] ${payload.laneId} ${previousStatus ?? 'new'} -> ${payload.status}`);
  void publishRealtimeMutation({
    mutation: {
      mutationId: generateLaneLifecycleMutationId(payload.laneId),
      source: 'server',
      action: 'lane-lifecycle',
      status: 'completed',
      runtime: lane.runtime,
      surfaceId: payload.sessionKey ?? undefined,
      sessionKey: payload.sessionKey ?? undefined,
      laneId: payload.laneId,
      packetId: payload.packetId ?? undefined,
      repoPath: payload.repoPath,
      branch: payload.branch,
      laneStatus: payload.status,
      previousStatus: payload.previousStatus,
      timestamp: payload.timestamp,
      note: `${lane.label}: ${previousStatus ?? 'new'} -> ${payload.status}`,
      createdAt: payload.timestamp,
      settledAt: payload.timestamp,
    },
  });
}

function mapLaneRow(row: LaneRow | undefined): Lane | null {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    label: row.label,
    repoPath: row.repoPath,
    worktreePath: row.worktreePath,
    branch: row.branch,
    baseBranch: row.baseBranch,
    runtime: row.runtime as LaneRuntime,
    sessionKey: row.sessionKey,
    packetId: row.packetId,
    status: row.status as LaneStatus,
    ownership: row.ownership as LaneOwnership,
    writerToken: row.writerToken,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastEventAt: row.lastEventAt,
    lastEventLabel: row.lastEventLabel,
  };
}

function parseEventPayload(payloadJson: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(payloadJson);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Invalid payloads should not break lane reads.
  }
  return {};
}

function mapLaneEventRow(row: LaneEventRow): LaneEvent {
  return {
    id: row.id,
    laneId: row.laneId,
    verb: row.verb,
    actor: row.actor as LaneEventActor,
    payload: parseEventPayload(row.payloadJson),
    timestamp: row.timestamp,
  };
}

function appendEvent(
  laneId: string,
  verb: string,
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

  getLaneDb().insert(laneEvents).values({
    id: event.id,
    laneId: event.laneId,
    verb: event.verb,
    actor: event.actor,
    payloadJson: JSON.stringify(event.payload),
    timestamp: event.timestamp,
  }).run();

  return event;
}

function updateLaneRecord(
  laneId: string,
  updates: Partial<typeof lanes.$inferInsert>,
) {
  if (Object.keys(updates).length === 0) {
    return;
  }
  getLaneDb().update(lanes).set(updates).where(eq(lanes.id, laneId)).run();
}

function getOrderedLaneList(): Lane[] {
  return getLaneDb()
    .select()
    .from(lanes)
    .orderBy(asc(lanes.createdAt))
    .all()
    .map((row) => mapLaneRow(row)!)
    .filter((lane): lane is Lane => lane !== null);
}

function getFilteredLaneList(
  whereClause?: ReturnType<typeof and>,
): Lane[] {
  const rows = whereClause
    ? getLaneDb()
      .select()
      .from(lanes)
      .where(whereClause)
      .orderBy(asc(lanes.createdAt))
      .all()
    : getLaneDb()
      .select()
      .from(lanes)
      .orderBy(asc(lanes.createdAt))
      .all();

  return rows
    .map((row) => mapLaneRow(row)!)
    .filter((lane): lane is Lane => lane !== null);
}

export function createLane(opts: {
  repoPath: string;
  branch: string;
  baseBranch?: string;
  runtime: LaneRuntime;
  label?: string;
  packetId?: string;
  ownership?: LaneOwnership;
  sessionKey?: string;
  worktreePath?: string;
  actor?: LaneEventActor;
}): Lane {
  const db = getSqlite();
  const id = generateLaneId();
  const now = nowIso();
  const lane: Lane = {
    id,
    label: opts.label || `${opts.runtime} — ${opts.branch}`,
    repoPath: opts.repoPath,
    worktreePath: opts.worktreePath ?? null,
    branch: opts.branch,
    baseBranch: opts.baseBranch ?? 'main',
    runtime: opts.runtime,
    sessionKey: opts.sessionKey ?? null,
    packetId: opts.packetId ?? null,
    status: 'idle',
    ownership: opts.ownership ?? 'managed',
    writerToken: null,
    createdAt: now,
    updatedAt: now,
    lastEventAt: null,
    lastEventLabel: null,
  };

  db.transaction(() => {
    getLaneDb().insert(lanes).values(lane).run();
    appendEvent(id, 'open_lane', opts.actor ?? 'system', {
      repoPath: opts.repoPath,
      branch: opts.branch,
      runtime: opts.runtime,
      packetId: opts.packetId ?? null,
    });
    publishLaneLifecycleEvent(lane, null, now);
  })();

  console.log(`[lane-registry] Created lane ${id} for ${opts.repoPath} @ ${opts.branch}`);
  return lane;
}

export function getLane(laneId: string): Lane | null {
  const row = getLaneDb().select().from(lanes).where(eq(lanes.id, laneId)).get();
  return mapLaneRow(row);
}

export function listLanes(): Lane[] {
  return getOrderedLaneList();
}

export function listActiveLanes(): Lane[] {
  return getFilteredLaneList(and(
    ne(lanes.status, 'archived'),
    ne(lanes.status, 'completed'),
  ));
}

export function listActiveLanesWithSessions(): Lane[] {
  return getFilteredLaneList(and(
    ne(lanes.status, 'archived'),
    ne(lanes.status, 'completed'),
    isNotNull(lanes.sessionKey),
  ));
}

export function findLaneBySession(sessionKey: string): Lane | null {
  const row = getLaneDb()
    .select()
    .from(lanes)
    .where(eq(lanes.sessionKey, sessionKey))
    .get();
  return mapLaneRow(row);
}

export function findLaneByPacket(packetId: string): Lane | null {
  const row = getLaneDb()
    .select()
    .from(lanes)
    .where(eq(lanes.packetId, packetId))
    .get();
  return mapLaneRow(row);
}

export function findLaneByRepoAndBranch(repoPath: string, branch: string): Lane | null {
  const row = getLaneDb()
    .select()
    .from(lanes)
    .where(and(
      eq(lanes.repoPath, repoPath),
      eq(lanes.branch, branch),
      notInArray(lanes.status, ['archived', 'completed']),
    ))
    .get();
  return mapLaneRow(row);
}

export function updateLane(
  laneId: string,
  updates: Partial<Pick<Lane, 'status' | 'sessionKey' | 'worktreePath' | 'writerToken' | 'label' | 'lastEventAt' | 'lastEventLabel' | 'packetId'>>,
  actor: LaneEventActor = 'system',
): Lane | null {
  const db = getSqlite();
  let updatedLane: Lane | null = null;
  let previousStatus: LaneStatus | null = null;
  let statusChanged = false;
  let lifecycleTimestamp: string | null = null;

  db.transaction(() => {
    const lane = getLane(laneId);
    if (!lane) {
      return;
    }

    previousStatus = lane.status;
    const now = nowIso();
    lifecycleTimestamp = now;
    const changes: Record<string, unknown> = {};
    const nextValues: Partial<typeof lanes.$inferInsert> = {};
    const updatableKeys: Array<keyof typeof updates> = [
      'status',
      'sessionKey',
      'worktreePath',
      'writerToken',
      'label',
      'lastEventAt',
      'lastEventLabel',
      'packetId',
    ];

    for (const key of updatableKeys) {
      const value = updates[key];
      if (value !== undefined && lane[key as keyof Lane] !== value) {
        (nextValues as Record<string, unknown>)[key] = value;
        changes[key] = value;
      }
    }

    if (Object.keys(changes).length === 0) {
      updatedLane = lane;
      return;
    }

    nextValues.updatedAt = now;
    statusChanged = nextValues.status !== undefined;
    updateLaneRecord(laneId, nextValues);

    if (statusChanged) {
      appendEvent(laneId, 'status_change', actor, { status: changes.status });
    } else {
      appendEvent(laneId, 'update', actor, changes);
    }

    updatedLane = getLane(laneId);
  })();

  if (!updatedLane) {
    return updatedLane;
  }

  if (statusChanged && previousStatus) {
    publishLaneLifecycleEvent(updatedLane, previousStatus, lifecycleTimestamp ?? nowIso());
  }

  return updatedLane;
}

export function setLaneStatus(
  laneId: string,
  status: LaneStatus,
  actor: LaneEventActor = 'system',
  eventLabel?: string,
): Lane | null {
  const now = nowIso();
  return updateLane(
    laneId,
    { status, lastEventAt: now, lastEventLabel: eventLabel ?? status },
    actor,
  );
}

export function attachSession(
  laneId: string,
  sessionKey: string,
  actor: LaneEventActor = 'system',
): Lane | null {
  const lane = getLane(laneId);
  if (!lane) return null;

  const now = nowIso();
  updateLaneRecord(laneId, {
    sessionKey,
    updatedAt: now,
    lastEventAt: now,
    lastEventLabel: 'session_attached',
  });

  appendEvent(laneId, 'attach_session', actor, { sessionKey });
  return getLane(laneId);
}

export function detachSession(
  laneId: string,
  actor: LaneEventActor = 'system',
): Lane | null {
  const lane = getLane(laneId);
  if (!lane) return null;

  updateLaneRecord(laneId, {
    sessionKey: null,
    updatedAt: nowIso(),
  });

  appendEvent(laneId, 'detach_session', actor, { previousSessionKey: lane.sessionKey });
  return getLane(laneId);
}

export function getLaneEvents(laneId: string, limit = 50): LaneEvent[] {
  return getLaneDb()
    .select()
    .from(laneEvents)
    .where(eq(laneEvents.laneId, laneId))
    .orderBy(desc(laneEvents.timestamp))
    .limit(limit)
    .all()
    .map(mapLaneEventRow)
    .reverse();
}

export function getAllEvents(limit = 200): LaneEvent[] {
  return getLaneDb()
    .select()
    .from(laneEvents)
    .orderBy(desc(laneEvents.timestamp))
    .limit(limit)
    .all()
    .map(mapLaneEventRow)
    .reverse();
}

export function reconcileLanesWithSessions(
  activeSessions: Array<{ sessionKey: string; runtimeId: string; cwd: string; branch?: string; status: string }>,
) {
  const db = getSqlite();

  db.transaction(() => {
    expireStaleApprovals();
    const currentLanes = listLanes();
    const sessionByKey = new Map(activeSessions.map((session) => [session.sessionKey, session]));
    const laneBySession = new Map(
      currentLanes
        .filter((lane) => lane.sessionKey)
        .map((lane) => [lane.sessionKey!, lane.id] as const),
    );

    for (const lane of currentLanes) {
      if (lane.status === 'archived' || lane.status === 'completed') continue;

      if (lane.sessionKey) {
        const session = sessionByKey.get(lane.sessionKey);
        if (!session) {
          console.log('[session-lifecycle] session_lost detected', {
            laneId: lane.id,
            sessionKey: lane.sessionKey,
            status: lane.status,
          });
          const nextValues: Partial<typeof lanes.$inferInsert> = {
            sessionKey: null,
            updatedAt: nowIso(),
          };
          let lifecycleTimestamp: string | null = null;

          if (lane.status === 'running' || lane.status === 'launching') {
            const now = nowIso();
            nextValues.status = 'paused';
            nextValues.lastEventAt = now;
            nextValues.lastEventLabel = 'session_lost';
            lifecycleTimestamp = now;
            appendEvent(lane.id, 'session_lost', 'system', { lostSessionKey: lane.sessionKey });
          }

          updateLaneRecord(lane.id, nextValues);
          if (nextValues.status) {
            const updatedLane = getLane(lane.id);
            if (updatedLane) {
              publishLaneLifecycleEvent(updatedLane, lane.status, lifecycleTimestamp ?? nowIso());
            }
          }
          laneBySession.delete(lane.sessionKey);
          continue;
        }

        const nextValues: Partial<typeof lanes.$inferInsert> = {};
        let lifecycleTimestamp: string | null = null;
        if (session.status === 'running' && lane.status !== 'running') {
          const now = nowIso();
          nextValues.status = 'running';
          nextValues.lastEventAt = now;
          nextValues.lastEventLabel = 'session_running';
          lifecycleTimestamp = now;
        } else if (session.status === 'waiting' && lane.status === 'running') {
          const now = nowIso();
          nextValues.status = 'awaiting_input';
          nextValues.lastEventAt = now;
          nextValues.lastEventLabel = 'awaiting_input';
          lifecycleTimestamp = now;
        } else if (session.status === 'reviewing' && lane.status !== 'reviewing') {
          const now = nowIso();
          nextValues.status = 'reviewing';
          nextValues.lastEventAt = now;
          nextValues.lastEventLabel = 'review_ready';
          lifecycleTimestamp = now;
        }

        if (Object.keys(nextValues).length > 0) {
          nextValues.updatedAt = nowIso();
          updateLaneRecord(lane.id, nextValues);
          if (nextValues.status) {
            const updatedLane = getLane(lane.id);
            if (updatedLane) {
              publishLaneLifecycleEvent(updatedLane, lane.status, lifecycleTimestamp ?? nowIso());
            }
          }
        }
        continue;
      }

      if (lane.status === 'idle' || lane.status === 'paused') {
        const match = activeSessions.find(
          (session) =>
            session.runtimeId === lane.runtime &&
            (session.cwd === lane.repoPath || session.cwd === lane.worktreePath) &&
            session.branch === lane.branch &&
            !laneBySession.has(session.sessionKey),
        );

        if (match) {
          console.log('[session-lifecycle] session reconnected', {
            laneId: lane.id,
            newSessionKey: match.sessionKey,
          });
          const now = nowIso();
          const nextStatus: LaneStatus = match.status === 'running' ? 'running' : 'paused';
          updateLaneRecord(lane.id, {
            sessionKey: match.sessionKey,
            ownership: 'attached',
            status: nextStatus,
            updatedAt: now,
            lastEventAt: now,
            lastEventLabel: 'session_discovered',
          });

          appendEvent(lane.id, 'attach_session', 'system', {
            sessionKey: match.sessionKey,
            discoveredFrom: 'reconciliation',
          });
          if (nextStatus !== lane.status) {
            const updatedLane = getLane(lane.id);
            if (updatedLane) {
              publishLaneLifecycleEvent(updatedLane, lane.status, now);
            }
          }
          laneBySession.set(match.sessionKey, lane.id);
        }
      }
    }
  })();
}

export function archiveLane(laneId: string, actor: LaneEventActor = 'user'): Lane | null {
  return setLaneStatus(laneId, 'archived', actor, 'archived');
}

export function archiveCompletedLanes(): number {
  const completedLanes = listLanes().filter((lane) => lane.status === 'completed');
  for (const lane of completedLanes) {
    const now = nowIso();
    updateLaneRecord(lane.id, {
      status: 'archived',
      updatedAt: now,
    });
    appendEvent(lane.id, 'auto_archive', 'system', {});
    const updatedLane = getLane(lane.id);
    if (updatedLane) {
      publishLaneLifecycleEvent(updatedLane, lane.status, now);
    }
  }
  return completedLanes.length;
}
