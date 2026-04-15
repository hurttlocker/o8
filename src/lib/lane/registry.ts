import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { and, asc, desc, eq, isNotNull, ne, notInArray } from 'drizzle-orm';
import { expireStaleApprovals } from '@/lib/approvals/store';
import { getDb, getSqlite, laneEvents, lanes } from '@/lib/db';
import { O8WebviewClient } from '@/lib/mcp/o8-webview-client';
import { publishLaneLifecycleEvent } from './lifecycle';
import { extractLaneReviewScreenshot } from './review-screenshot';
import type {
  Lane,
  LaneEvent,
  LaneEventActor,
  LaneOwnership,
  LaneRuntime,
  LaneStatus,
} from './types';
import { cleanupLaneWorktree } from './worktree-cleanup';

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

// session_lost grace period: reconciliation runs frequently and session
// discovery has transient blind spots (runtime adapter restart, polling race,
// slow gateway). Without a grace period a healthy agent can flip to
// session_lost within seconds even though its process is still writing files
// in the worktree. Require the key to be missing for this many ms before we
// fire session_lost.
const SESSION_LOST_GRACE_MS = 90_000;
const sessionMissingSince = new Map<string, number>();
const REVIEW_SCREENSHOT_DIR = join(homedir(), '.o8', 'review-screenshots');
let reviewScreenshotClient: O8WebviewClient | null = null;

function getLaneDb() {
  const db = getDb();
  if (!db) {
    throw new Error('[lane-registry] SQLite database is unavailable');
  }
  return db;
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

function getReviewScreenshotClient() {
  reviewScreenshotClient ??= new O8WebviewClient();
  return reviewScreenshotClient;
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

function updateLaneEventPayload(
  eventId: string,
  updates: Record<string, unknown>,
) {
  if (Object.keys(updates).length === 0) {
    return;
  }

  const row = getLaneDb()
    .select()
    .from(laneEvents)
    .where(eq(laneEvents.id, eventId))
    .get();

  if (!row) {
    return;
  }

  const nextPayload = {
    ...parseEventPayload(row.payloadJson),
    ...updates,
  };

  getLaneDb()
    .update(laneEvents)
    .set({ payloadJson: JSON.stringify(nextPayload) })
    .where(eq(laneEvents.id, eventId))
    .run();
}

async function captureReviewBoundaryScreenshot(
  laneId: string,
  eventId: string,
) {
  try {
    const screenshot = await getReviewScreenshotClient().screenshot();
    if (screenshot.mimeType !== 'image/png') {
      throw new Error(`Expected image/png from o8 screenshot capture, received ${screenshot.mimeType}`);
    }

    const capturedAt = nowIso();
    const screenshotPath = join(REVIEW_SCREENSHOT_DIR, `${laneId}.png`);
    const screenshotBuffer = Buffer.from(screenshot.imageBase64, 'base64');
    const payload: Record<string, unknown> = {
      reviewScreenshotMimeType: screenshot.mimeType,
      reviewScreenshotWidth: screenshot.width,
      reviewScreenshotHeight: screenshot.height,
      reviewScreenshotCapturedAt: capturedAt,
    };

    try {
      await mkdir(REVIEW_SCREENSHOT_DIR, { recursive: true });
      await writeFile(screenshotPath, screenshotBuffer);
      payload.reviewScreenshotPath = screenshotPath;
    } catch (writeError) {
      console.warn(`[lane-registry] Failed to write review screenshot file for lane ${laneId}; storing base64 in the event payload instead.`, writeError);
      payload.reviewScreenshotBase64 = screenshot.imageBase64;
    }

    updateLaneEventPayload(eventId, payload);
  } catch (error) {
    console.error(`[lane-registry] Failed to capture review screenshot for lane ${laneId}:`, error);
  }
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
    .where(and(
      eq(lanes.sessionKey, sessionKey),
      notInArray(lanes.status, ['archived', 'completed']),
    ))
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
  let statusChangeEventId: string | null = null;
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
      statusChangeEventId = appendEvent(laneId, 'status_change', actor, { status: changes.status }).id;
    } else {
      appendEvent(laneId, 'update', actor, changes);
    }

    updatedLane = getLane(laneId);
  })();

  const nextLane: Lane | null = updatedLane;
  if (nextLane === null) {
    return null;
  }
  const resolvedLane = nextLane as Lane;

  if (statusChanged && previousStatus) {
    publishLaneLifecycleEvent(resolvedLane, previousStatus, lifecycleTimestamp ?? nowIso());
  }

  if (
    statusChanged
    && previousStatus !== 'reviewing'
    && resolvedLane.status === 'reviewing'
    && statusChangeEventId
  ) {
    void captureReviewBoundaryScreenshot(resolvedLane.id, statusChangeEventId);
  }

  return resolvedLane;
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

export function getLatestLaneReviewScreenshot(laneId: string, limit = 50) {
  const events = getLaneEvents(laneId, limit);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const screenshot = extractLaneReviewScreenshot(events[index]?.payload);
    if (screenshot) {
      return screenshot;
    }
  }

  return null;
}

export interface ReviewTransitionEntry {
  laneId: string;
  worktreePath: string;
}

export function reconcileLanesWithSessions(
  activeSessions: Array<{ sessionKey: string; runtimeId: string; cwd: string; branch?: string; status: string }>,
): ReviewTransitionEntry[] {
  const db = getSqlite();
  const pendingReviewCommits: ReviewTransitionEntry[] = [];

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
          // Grace period: transient discovery blind spots should not fire
          // session_lost. Record when the key was first seen missing and only
          // act after SESSION_LOST_GRACE_MS has elapsed. If the key reappears
          // on a later tick the timer is cleared below.
          const firstMissingAt = sessionMissingSince.get(lane.sessionKey) ?? Date.now();
          sessionMissingSince.set(lane.sessionKey, firstMissingAt);
          const missingFor = Date.now() - firstMissingAt;
          if (missingFor < SESSION_LOST_GRACE_MS) {
            // Still within grace window — leave lane alone this tick.
            continue;
          }

          console.log('[session-lifecycle] session_lost detected', {
            laneId: lane.id,
            sessionKey: lane.sessionKey,
            status: lane.status,
            missingMs: missingFor,
          });
          sessionMissingSince.delete(lane.sessionKey);
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

        // Session came back (or never went missing) — clear any pending grace timer.
        sessionMissingSince.delete(lane.sessionKey);

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
          // #454 — Collect lanes transitioning to reviewing so the caller can
          // auto-commit any dirty worktrees after this synchronous transaction.
          const commitCwd = lane.worktreePath ?? lane.repoPath;
          if (commitCwd) {
            pendingReviewCommits.push({ laneId: lane.id, worktreePath: commitCwd });
          }
        }

        // #8 / #467 — Safety net: if a lane has been 'running' for 2+ hours with no
        // event update AND the session is not in the active sessions list, the agent
        // is likely silently dead. Only trigger when the session is actually gone —
        // a healthy agent working for hours is fine as long as the session exists.
        if (
          Object.keys(nextValues).length === 0
          && lane.status === 'running'
          && lane.lastEventAt
          && !session // session NOT in active sessions list
        ) {
          const staleMs = Date.now() - new Date(lane.lastEventAt).getTime();
          if (staleMs > 2 * 60 * 60 * 1000) {
            const now = nowIso();
            console.log(`[session-lifecycle] Stale running lane detected: ${lane.id} — no session + no activity for ${Math.round(staleMs / 60000)}m`);
            nextValues.status = 'paused';
            nextValues.lastEventAt = now;
            nextValues.lastEventLabel = 'session_stale';
            lifecycleTimestamp = now;
          }
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

  return pendingReviewCommits;
}

export function archiveLane(laneId: string, actor: LaneEventActor = 'user'): Lane | null {
  const lane = getLane(laneId);
  if (!lane) {
    return null;
  }

  // Keep sessionKey on archive — it lets clients correlate archived lanes
  // back to their spawned sessions (sidebar filter, history drawer). Since
  // `findLaneBySession()` now excludes archived rows, leaving the key in
  // place doesn't collide with future launches that reuse the same key.
  // worktreePath stays nulled so the reaper doesn't re-enter cleanup.
  const updated = updateLane(laneId, {
    status: 'archived',
    worktreePath: null,
    writerToken: null,
    lastEventAt: nowIso(),
    lastEventLabel: 'archived',
  }, actor);

  if (lane.worktreePath) {
    void cleanupLaneWorktree(lane).catch((error) => {
      console.error(`[lane-worktree] Cleanup failed for ${lane.id}: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  return updated;
}

export function archiveCompletedLanes(): number {
  const completedLanes = listLanes().filter((lane) => lane.status === 'completed');
  for (const lane of completedLanes) {
    archiveLane(lane.id, 'system');
    appendEvent(lane.id, 'auto_archive', 'system', {});
  }
  return completedLanes.length;
}
