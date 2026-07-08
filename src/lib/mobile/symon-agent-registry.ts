/**
 * Symon Agent Mode — the single `activeAgentSession` registry.
 *
 * The desktop keeps EXACTLY ONE phone-hosted agent session at a time
 * (docs/symon-agent-mode.md §"Session registry"). This module is the
 * process-local, re-derivable-from-status-events source of truth for it.
 *
 * Two consumers, two processes:
 *   - ws-server (owns the `symon` WS channel) drives the IN-MEMORY registry from
 *     phone status events / tool calls, and mirrors it to disk via
 *     {@link persistAgentSession} after every change.
 *   - the Next GET `/api/mobile/symon` route reads the disk mirror via
 *     {@link loadPersistedAgentSession} to populate its additive `agentSession`
 *     field (it lives in a different process, so it cannot see the in-memory one).
 *
 * The mutators are pure over a globalThis singleton (no file IO) so the
 * mutual-exclusion + stale-sweep logic is unit-testable without touching disk.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type AgentSessionStatus = 'connecting' | 'live' | 'acting' | 'idle' | 'error';

export interface AgentSessionRecord {
  sessionId: string;
  startedAt: number;
  lastStatus: AgentSessionStatus;
  lastActivityAt: number;
  source: 'phone';
}

/** No status event or tool call for this long → the session is swept to idle. */
export const AGENT_SESSION_STALE_MS = 10 * 60 * 1000;

/** Statuses that mean the session is over (phone teardown / error). */
const TERMINAL_STATUSES = new Set<AgentSessionStatus>(['idle', 'error']);

interface RegistryStore {
  current: AgentSessionRecord | null;
}

function store(): RegistryStore {
  const g = globalThis as typeof globalThis & { __o8SymonAgentRegistry?: RegistryStore };
  if (!g.__o8SymonAgentRegistry) g.__o8SymonAgentRegistry = { current: null };
  return g.__o8SymonAgentRegistry;
}

/** The live in-memory record (ws-server process). */
export function getAgentSession(): AgentSessionRecord | null {
  return store().current;
}

/**
 * Register / refresh a session as the active one — LAST-START-WINS. If a
 * DIFFERENT session was active it is returned as `preempted` so the caller pushes
 * the idle notice to that old phone over the `symon` channel. Re-registering the
 * SAME id (the phone's `connecting` after its own mint) is idempotent and keeps
 * the original `startedAt`.
 */
export function startAgentSession(
  sessionId: string,
  now: number = Date.now(),
): { record: AgentSessionRecord; preempted: string | null } {
  const s = store();
  const prior = s.current;
  const preempted = prior && prior.sessionId !== sessionId ? prior.sessionId : null;
  s.current = {
    sessionId,
    startedAt: prior && prior.sessionId === sessionId ? prior.startedAt : now,
    lastStatus: 'connecting',
    lastActivityAt: now,
    source: 'phone',
  };
  return { record: s.current, preempted };
}

/**
 * Apply a phone-reported (or server-driven) status to the active session. A
 * terminal status (idle/error) clears the registry. A status for a NON-active
 * session id is ignored (a preempted session's late chatter must not resurrect
 * it) and returns null.
 */
export function updateAgentStatus(
  sessionId: string,
  status: AgentSessionStatus,
  now: number = Date.now(),
): AgentSessionRecord | null {
  const s = store();
  if (!s.current || s.current.sessionId !== sessionId) return null;
  if (TERMINAL_STATUSES.has(status)) {
    s.current = null;
    return null;
  }
  s.current = { ...s.current, lastStatus: status, lastActivityAt: now };
  return s.current;
}

/** Bump the activity clock for the active session (e.g. a tool call arrived). */
export function touchAgentSession(sessionId: string, now: number = Date.now()): AgentSessionRecord | null {
  const s = store();
  if (!s.current || s.current.sessionId !== sessionId) return null;
  s.current = { ...s.current, lastActivityAt: now };
  return s.current;
}

/**
 * Clear the active session. With a `sessionId`, only clears if it matches (a
 * stale stop from a preempted phone is a no-op). Without one, clears
 * unconditionally. Returns the record that was dropped, if any.
 */
export function stopAgentSession(sessionId?: string): AgentSessionRecord | null {
  const s = store();
  const prior = s.current;
  if (!prior) return null;
  if (sessionId && prior.sessionId !== sessionId) return null;
  s.current = null;
  return prior;
}

export function isAgentSessionStale(
  record: AgentSessionRecord,
  now: number = Date.now(),
  ttlMs: number = AGENT_SESSION_STALE_MS,
): boolean {
  return now - record.lastActivityAt > ttlMs;
}

/**
 * Drop the active session if it has gone quiet past the TTL. Returns the dropped
 * record (so the caller can push the idle notice) or null if nothing was swept.
 */
export function sweepStaleAgentSession(
  now: number = Date.now(),
  ttlMs: number = AGENT_SESSION_STALE_MS,
): AgentSessionRecord | null {
  const s = store();
  if (s.current && isAgentSessionStale(s.current, now, ttlMs)) {
    const dropped = s.current;
    s.current = null;
    return dropped;
  }
  return null;
}

// ── Disk mirror (cross-process: ws-server writes, Next GET reads) ─────────────

function dataDir(): string {
  return process.env.CORTEX_IDE_DATA_DIR || join(homedir(), '.o8');
}

function sessionFilePath(): string {
  return join(dataDir(), 'symon-agent-session.json');
}

/** Mirror the current record (or its absence) to disk. Best-effort. */
export function persistAgentSession(record: AgentSessionRecord | null): void {
  try {
    const dir = dataDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(sessionFilePath(), JSON.stringify(record), 'utf-8');
  } catch {
    // The registry is re-derivable from status events; a mirror-write hiccup is
    // non-fatal — the GET field just reads stale/absent state until the next one.
  }
}

/**
 * Read the disk mirror (for the Next GET, which runs in a different process than
 * the ws-server registry owner). Applies the SAME staleness guard so a crashed
 * ws-server can't leave a phantom "live from phone" banner up forever.
 */
export function loadPersistedAgentSession(
  now: number = Date.now(),
  ttlMs: number = AGENT_SESSION_STALE_MS,
): AgentSessionRecord | null {
  try {
    const path = sessionFilePath();
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, 'utf-8').trim();
    if (!raw || raw === 'null') return null;
    const parsed = JSON.parse(raw) as Partial<AgentSessionRecord> | null;
    if (!parsed || typeof parsed.sessionId !== 'string' || typeof parsed.lastActivityAt !== 'number') {
      return null;
    }
    const record: AgentSessionRecord = {
      sessionId: parsed.sessionId,
      startedAt: typeof parsed.startedAt === 'number' ? parsed.startedAt : parsed.lastActivityAt,
      lastStatus: (parsed.lastStatus as AgentSessionStatus) || 'live',
      lastActivityAt: parsed.lastActivityAt,
      source: 'phone',
    };
    return isAgentSessionStale(record, now, ttlMs) ? null : record;
  } catch {
    return null;
  }
}
