import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type {
  Lane,
  LaneEvent,
  LaneEventActor,
  LaneOwnership,
  LaneRuntime,
  LaneStatus,
  LaneStoreState,
} from './types';

// ── Storage ──

const STATE_DIR = path.join(os.homedir(), '.cortex-ide');
const STORE_PATH = path.join(STATE_DIR, 'lanes.json');
const MAX_EVENTS = 500;

function nowIso() {
  return new Date().toISOString();
}

function generateLaneId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `lane-${crypto.randomUUID().slice(0, 12)}`;
  }
  return `lane-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function generateEventId(): string {
  return `evt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// ── In-Memory State ──

let state: LaneStoreState = {
  version: 1,
  lanes: {},
  events: [],
  updatedAt: nowIso(),
};

let loaded = false;

// ── Persistence ──

function ensureDir() {
  if (!fs.existsSync(STATE_DIR)) {
    fs.mkdirSync(STATE_DIR, { recursive: true });
  }
}

function loadFromDisk(): LaneStoreState {
  try {
    if (!fs.existsSync(STORE_PATH)) {
      return { version: 1, lanes: {}, events: [], updatedAt: nowIso() };
    }
    const raw = fs.readFileSync(STORE_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as LaneStoreState;
    if (parsed.version !== 1) {
      console.warn('[lane-registry] Unknown store version, resetting');
      return { version: 1, lanes: {}, events: [], updatedAt: nowIso() };
    }
    return parsed;
  } catch (err) {
    console.error('[lane-registry] Failed to load store:', err);
    return { version: 1, lanes: {}, events: [], updatedAt: nowIso() };
  }
}

function persistToDisk() {
  try {
    ensureDir();
    const tmp = `${STORE_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf-8');
    fs.renameSync(tmp, STORE_PATH);
  } catch (err) {
    console.error('[lane-registry] Failed to persist store:', err);
  }
}

function ensureLoaded() {
  if (!loaded) {
    state = loadFromDisk();
    loaded = true;
  }
}

// ── Event Logging ──

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
  state.events.push(event);
  if (state.events.length > MAX_EVENTS) {
    state.events = state.events.slice(-MAX_EVENTS);
  }
  return event;
}

// ── CRUD ──

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
  ensureLoaded();

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

  state.lanes[id] = lane;
  state.updatedAt = now;
  appendEvent(id, 'open_lane', opts.actor ?? 'system', {
    repoPath: opts.repoPath,
    branch: opts.branch,
    runtime: opts.runtime,
    packetId: opts.packetId ?? null,
  });
  persistToDisk();

  console.log(`[lane-registry] Created lane ${id} for ${opts.repoPath} @ ${opts.branch}`);
  return lane;
}

export function getLane(laneId: string): Lane | null {
  ensureLoaded();
  return state.lanes[laneId] ?? null;
}

export function listLanes(): Lane[] {
  ensureLoaded();
  return Object.values(state.lanes);
}

export function listActiveLanes(): Lane[] {
  return listLanes().filter(
    (lane) => lane.status !== 'archived' && lane.status !== 'completed',
  );
}

export function findLaneBySession(sessionKey: string): Lane | null {
  ensureLoaded();
  return Object.values(state.lanes).find((lane) => lane.sessionKey === sessionKey) ?? null;
}

export function findLaneByPacket(packetId: string): Lane | null {
  ensureLoaded();
  return Object.values(state.lanes).find((lane) => lane.packetId === packetId) ?? null;
}

export function findLaneByRepoAndBranch(repoPath: string, branch: string): Lane | null {
  ensureLoaded();
  return Object.values(state.lanes).find(
    (lane) =>
      lane.repoPath === repoPath &&
      lane.branch === branch &&
      lane.status !== 'archived' &&
      lane.status !== 'completed',
  ) ?? null;
}

export function updateLane(
  laneId: string,
  updates: Partial<Pick<Lane, 'status' | 'sessionKey' | 'worktreePath' | 'writerToken' | 'label' | 'lastEventAt' | 'lastEventLabel' | 'packetId'>>,
  actor: LaneEventActor = 'system',
): Lane | null {
  ensureLoaded();
  const lane = state.lanes[laneId];
  if (!lane) return null;

  const now = nowIso();
  const changes: Record<string, unknown> = {};
  const laneRecord = lane as unknown as Record<string, unknown>;

  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined && laneRecord[key] !== value) {
      laneRecord[key] = value;
      changes[key] = value;
    }
  }

  if (Object.keys(changes).length === 0) return lane;

  lane.updatedAt = now;
  state.updatedAt = now;

  if (changes.status) {
    appendEvent(laneId, 'status_change', actor, { status: changes.status });
  } else {
    appendEvent(laneId, 'update', actor, changes);
  }

  persistToDisk();
  return lane;
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
  ensureLoaded();
  const lane = state.lanes[laneId];
  if (!lane) return null;

  const now = nowIso();
  lane.sessionKey = sessionKey;
  lane.updatedAt = now;
  lane.lastEventAt = now;
  lane.lastEventLabel = 'session_attached';
  state.updatedAt = now;

  appendEvent(laneId, 'attach_session', actor, { sessionKey });
  persistToDisk();
  return lane;
}

export function detachSession(
  laneId: string,
  actor: LaneEventActor = 'system',
): Lane | null {
  ensureLoaded();
  const lane = state.lanes[laneId];
  if (!lane) return null;

  const previousKey = lane.sessionKey;
  lane.sessionKey = null;
  lane.updatedAt = nowIso();
  state.updatedAt = lane.updatedAt;

  appendEvent(laneId, 'detach_session', actor, { previousSessionKey: previousKey });
  persistToDisk();
  return lane;
}

// ── Events ──

export function getLaneEvents(laneId: string, limit = 50): LaneEvent[] {
  ensureLoaded();
  return state.events
    .filter((event) => event.laneId === laneId)
    .slice(-limit);
}

export function getAllEvents(limit = 100): LaneEvent[] {
  ensureLoaded();
  return state.events.slice(-limit);
}

// ── Reconciliation ──

export function reconcileLanesWithSessions(
  activeSessions: Array<{ sessionKey: string; runtimeId: string; cwd: string; branch?: string; status: string }>,
) {
  ensureLoaded();

  const sessionByKey = new Map(activeSessions.map((session) => [session.sessionKey, session]));

  for (const lane of Object.values(state.lanes)) {
    if (lane.status === 'archived' || lane.status === 'completed') continue;

    // If lane has a session, check if it's still alive
    if (lane.sessionKey) {
      const session = sessionByKey.get(lane.sessionKey);
      if (!session) {
        // Session died — detach but don't archive the lane
        if (lane.status === 'running' || lane.status === 'launching') {
          lane.status = 'paused';
          lane.lastEventAt = nowIso();
          lane.lastEventLabel = 'session_lost';
          appendEvent(lane.id, 'session_lost', 'system', { lostSessionKey: lane.sessionKey });
        }
        lane.sessionKey = null;
        lane.updatedAt = nowIso();
        continue;
      }

      // Session alive — sync status
      const runtimeStatus = session.status;
      if (runtimeStatus === 'running' && lane.status !== 'running') {
        lane.status = 'running';
        lane.lastEventAt = nowIso();
        lane.lastEventLabel = 'session_running';
      } else if (runtimeStatus === 'waiting' && lane.status === 'running') {
        lane.status = 'awaiting_input';
        lane.lastEventAt = nowIso();
        lane.lastEventLabel = 'awaiting_input';
      } else if (runtimeStatus === 'reviewing' && lane.status !== 'reviewing') {
        lane.status = 'reviewing';
        lane.lastEventAt = nowIso();
        lane.lastEventLabel = 'review_ready';
      }
      lane.updatedAt = nowIso();
      continue;
    }

    // Lane has no session — try to find a matching one
    if (lane.status === 'idle' || lane.status === 'paused') {
      const match = activeSessions.find(
        (session) =>
          session.runtimeId === lane.runtime &&
          (session.cwd === lane.repoPath || session.cwd === lane.worktreePath) &&
          session.branch === lane.branch &&
          !findLaneBySession(session.sessionKey),
      );
      if (match) {
        lane.sessionKey = match.sessionKey;
        lane.ownership = 'attached';
        lane.status = match.status === 'running' ? 'running' : 'paused';
        lane.updatedAt = nowIso();
        lane.lastEventAt = nowIso();
        lane.lastEventLabel = 'session_discovered';
        appendEvent(lane.id, 'attach_session', 'system', {
          sessionKey: match.sessionKey,
          discoveredFrom: 'reconciliation',
        });
      }
    }
  }

  state.updatedAt = nowIso();
  persistToDisk();
}

// ── Cleanup ──

export function archiveLane(laneId: string, actor: LaneEventActor = 'user'): Lane | null {
  return setLaneStatus(laneId, 'archived', actor, 'archived');
}

export function archiveCompletedLanes(): number {
  ensureLoaded();
  let count = 0;
  for (const lane of Object.values(state.lanes)) {
    if (lane.status === 'completed') {
      lane.status = 'archived';
      lane.updatedAt = nowIso();
      appendEvent(lane.id, 'auto_archive', 'system', {});
      count++;
    }
  }
  if (count > 0) {
    state.updatedAt = nowIso();
    persistToDisk();
  }
  return count;
}
