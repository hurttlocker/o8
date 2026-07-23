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

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';

export type AgentSessionStatus = 'connecting' | 'live' | 'acting' | 'idle' | 'error';

export interface AgentSessionRecord {
  sessionId: string;
  startedAt: number;
  lastStatus: AgentSessionStatus;
  lastActivityAt: number;
  source: 'phone';
}

export const SYMON_SCOPE_VERSION = 1 as const;

export type SymonScopeSubject = 'operator' | 'device';
export type SymonWorkspaceMode = 'o8' | 'code';

/**
 * Server-issued authority for one phone-hosted Symon session. This is persisted
 * separately from the derived status mirror: the Next mint owns the grant,
 * while the WS process owns the frequently-changing status record.
 */
export interface SymonScopeGrant {
  sessionId: string;
  subject: SymonScopeSubject;
  deviceId: string | null;
  workspaceMode: SymonWorkspaceMode;
  repoId: string | null;
  repoPath: string | null;
  allowedTools: string[];
  issuedAt: number;
  scopeVersion: typeof SYMON_SCOPE_VERSION;
}

export interface SymonClientSubject {
  subject: SymonScopeSubject;
  deviceId: string | null;
}

export type ScopedSymonToolArgsResult =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; error: 'tool_not_allowed' | 'repo_scope_mismatch'; detail: string };

const REPO_ARGUMENT_TOOLS = new Set([
  'o8_status',
  'o8_dispatch',
  'o8_delegate',
  'o8_stop_agent',
  'git_status',
  'git_log',
]);

const STABLE_TARGET_TOOLS = new Set([
  'o8_needs_me',
  'o8_review_diff',
  'o8_packet_wait',
  'o8_packet_steer',
  'o8_agent_task',
  'o8_packet_rerun',
  'o8_packet_reset',
  'o8_approve_item',
  'o8_reject_item',
]);

const EXPLICIT_REPO_PATH_ARGUMENTS = ['repo', 'repoPath', 'repo_path'] as const;

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
  return getDataDir();
}

function sessionFilePath(): string {
  return join(dataDir(), 'symon-agent-session.json');
}

function scopeGrantFilePath(): string {
  return join(dataDir(), 'symon-scope-grant.json');
}

function isValidScopeGrant(value: unknown): value is SymonScopeGrant {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const grant = value as Partial<SymonScopeGrant>;
  if (grant.scopeVersion !== SYMON_SCOPE_VERSION) return false;
  if (typeof grant.sessionId !== 'string' || !grant.sessionId.trim() || grant.sessionId.length > 160) return false;
  if (grant.subject !== 'operator' && grant.subject !== 'device') return false;
  if (grant.subject === 'device' && (typeof grant.deviceId !== 'string' || !grant.deviceId.trim())) return false;
  if (grant.subject === 'operator' && grant.deviceId !== null) return false;
  if (grant.workspaceMode !== 'o8' && grant.workspaceMode !== 'code') return false;
  if (grant.repoId !== null && (typeof grant.repoId !== 'string' || !grant.repoId.trim())) return false;
  if (grant.repoPath !== null && (typeof grant.repoPath !== 'string' || !grant.repoPath.startsWith('/'))) return false;
  if (grant.workspaceMode === 'code' && (grant.repoId === null || grant.repoPath === null)) return false;
  if (!Array.isArray(grant.allowedTools) || grant.allowedTools.length === 0) return false;
  if (!grant.allowedTools.every((tool) => typeof tool === 'string' && /^[A-Za-z0-9_:-]{1,96}$/.test(tool))) return false;
  return typeof grant.issuedAt === 'number' && Number.isFinite(grant.issuedAt) && grant.issuedAt > 0;
}

/** Atomically replace the one active grant. A failure is security-critical and throws. */
export function persistSymonScopeGrant(grant: SymonScopeGrant): void {
  if (!isValidScopeGrant(grant)) throw new Error('invalid Symon scope grant');
  const dir = dataDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = scopeGrantFilePath();
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(grant), { encoding: 'utf-8', flag: 'wx', mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, target);
    chmodSync(target, 0o600);
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
}

/** Read the active cross-process grant. Invalid/truncated files fail closed. */
export function loadSymonScopeGrant(): SymonScopeGrant | null {
  try {
    const path = scopeGrantFilePath();
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, 'utf-8').trim();
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    return isValidScopeGrant(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Revoke one exact session grant without risking deletion of a newer mint.
 * Moving the current file aside is atomic; if it belongs to another session we
 * restore it only when no newer writer has already installed a replacement.
 */
export function clearSymonScopeGrant(sessionId: string): boolean {
  const target = scopeGrantFilePath();
  if (!sessionId || !existsSync(target)) return false;
  const quarantine = `${target}.${process.pid}.${randomUUID()}.revoke`;
  try {
    renameSync(target, quarantine);
  } catch {
    return false;
  }

  let revoked = false;
  try {
    const parsed = JSON.parse(readFileSync(quarantine, 'utf-8')) as unknown;
    revoked = isValidScopeGrant(parsed) && parsed.sessionId === sessionId;
  } catch {
    // Invalid grants already fail closed; remove the quarantined copy.
    revoked = true;
  }

  if (!revoked && !existsSync(target)) {
    try {
      renameSync(quarantine, target);
      return false;
    } catch {
      // A concurrent mint may have installed a new target. Its file wins.
    }
  }
  try {
    if (existsSync(quarantine)) unlinkSync(quarantine);
  } catch {
    // Revocation already removed the active path; a quarantine cleanup failure
    // cannot restore authority and may be cleaned on the next maintenance pass.
  }
  return revoked;
}

/** Exact subject match for the status/tool/stop WS boundary. */
export function scopeGrantMatchesClient(
  grant: SymonScopeGrant,
  sessionId: string,
  client: SymonClientSubject,
): boolean {
  if (grant.sessionId !== sessionId || grant.subject !== client.subject) return false;
  return grant.subject === 'device'
    ? Boolean(grant.deviceId && grant.deviceId === client.deviceId)
    : client.deviceId === null;
}

/**
 * Apply the immutable Code repo scope at the last server-controlled boundary
 * before native tool execution. Life sessions retain their existing arguments.
 */
export function scopeSymonToolArgs(
  grant: SymonScopeGrant,
  tool: string,
  args: Record<string, unknown>,
): ScopedSymonToolArgsResult {
  if (!grant.allowedTools.includes(tool)) {
    return { ok: false, error: 'tool_not_allowed', detail: `${tool} is not allowed for this Symon session` };
  }

  // A governed plan is one outer model call, but its concrete steps remain
  // separate authorities. Scope and allowlist every nested call now, at the
  // same immutable phone-session boundary used for ordinary tools, so wrapping
  // an action in a plan can never widen its repository grant.
  if (tool === 'symon_execute_plan' && Array.isArray(args.steps)) {
    const scopedSteps: unknown[] = [];
    for (const value of args.steps) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        scopedSteps.push(value);
        continue;
      }
      const step = value as Record<string, unknown>;
      const stepTool = typeof step.tool === 'string' ? step.tool : '';
      if (stepTool === 'symon_execute_plan') {
        return {
          ok: false,
          error: 'tool_not_allowed',
          detail: 'A Symon plan cannot contain another plan',
        };
      }
      const stepArgs = step.args && typeof step.args === 'object' && !Array.isArray(step.args)
        ? step.args as Record<string, unknown>
        : {};
      const scoped = scopeSymonToolArgs(grant, stepTool, stepArgs);
      if (!scoped.ok) return scoped;
      scopedSteps.push({ ...step, args: scoped.args });
    }
    return { ok: true, args: { ...args, steps: scopedSteps } };
  }
  if (grant.workspaceMode !== 'code' || !grant.repoId || !grant.repoPath) return { ok: true, args: { ...args } };

  const scopedArgs = {
    ...args,
    repoId: grant.repoId,
    repoPath: grant.repoPath,
  };

  if (REPO_ARGUMENT_TOOLS.has(tool)) {
    return { ok: true, args: { ...scopedArgs, repo: grant.repoPath } };
  }

  if (STABLE_TARGET_TOOLS.has(tool)) {
    const suppliedRepoId = args.repoId;
    if (typeof suppliedRepoId === 'string' && suppliedRepoId.trim() && suppliedRepoId.trim() !== grant.repoId) {
      return {
        ok: false,
        error: 'repo_scope_mismatch',
        detail: `${tool} cannot target a repository outside the active Symon scope`,
      };
    }
    for (const key of EXPLICIT_REPO_PATH_ARGUMENTS) {
      const supplied = args[key];
      if (typeof supplied === 'string' && supplied.trim() && supplied.trim() !== grant.repoPath) {
        return {
          ok: false,
          error: 'repo_scope_mismatch',
          detail: `${tool} cannot target a repository outside the active Symon scope`,
        };
      }
    }
  }

  return { ok: true, args: scopedArgs };
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
