import 'server-only';

import { listLanes } from '@/lib/lane/registry';
import { isLaneTerminal } from '@/lib/lane/terminal-states';
import type { LaneStatus } from '@/lib/lane/types';
import { resolvePortInfo } from '@/lib/panel/api-port';
import { listManagedRuns } from '@/lib/runtimes/managed-runs/registry';
import { listOwnedActiveRuns } from '@/lib/runtimes/shared/owned-session-index';
import { getOrCreateWsToken } from '@/lib/ws-auth';

export interface UpdateIdleLane {
  id: string;
  label: string;
  status: LaneStatus;
  runtime: string;
  sessionKey: string | null;
}

export interface UpdateIdleTerminalSession {
  name: string;
  kind: 'dash-shell' | 'tmux-attach' | 'managed-process';
  clientCount: number;
  cwd: string | null;
  commandHint: string | null;
}

export interface UpdateIdleManagedRun {
  id: string;
  session: string;
  command: string;
  cwd: string;
}

export interface UpdateIdleOwnedSession {
  surfaceId: string;
  pid: number | null;
  tmuxSession: string | null;
}

export interface UpdateIdleWindow {
  idle: boolean;
  active: {
    lanes: UpdateIdleLane[];
    terminalSessions: UpdateIdleTerminalSession[];
    managedRuns: UpdateIdleManagedRun[];
    ownedSessions: UpdateIdleOwnedSession[];
  };
  unavailable: string[];
  checkedAt: string;
}

interface IdleWindowInput {
  lanes: UpdateIdleLane[];
  terminalSessions: UpdateIdleTerminalSession[];
  managedRuns: UpdateIdleManagedRun[];
  ownedSessions: UpdateIdleOwnedSession[];
  terminalInventoryAvailable: boolean;
  checkedAt?: string;
}

export function evaluateUpdateIdleWindow(input: IdleWindowInput): UpdateIdleWindow {
  const activeLanes = input.lanes.filter((lane) => !isLaneTerminal(lane.status));
  const terminalSessions = input.terminalSessions.filter((session) => (
    session.kind === 'managed-process' || session.clientCount > 0
  ));
  const unavailable = input.terminalInventoryAvailable ? [] : ['terminal-sessions'];
  return {
    idle: activeLanes.length === 0
      && terminalSessions.length === 0
      && input.managedRuns.length === 0
      && input.ownedSessions.length === 0
      && unavailable.length === 0,
    active: {
      lanes: activeLanes,
      terminalSessions,
      managedRuns: input.managedRuns,
      ownedSessions: input.ownedSessions,
    },
    unavailable,
    checkedAt: input.checkedAt ?? new Date().toISOString(),
  };
}

async function readTerminalInventory(): Promise<{
  available: boolean;
  sessions: UpdateIdleTerminalSession[];
}> {
  try {
    const { wsPort } = resolvePortInfo();
    const response = await fetch(`http://127.0.0.1:${wsPort}/terminal-voice-sessions`, {
      headers: { Authorization: `Bearer ${getOrCreateWsToken()}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) return { available: false, sessions: [] };
    const payload = await response.json() as { sessions?: unknown };
    if (!Array.isArray(payload.sessions)) return { available: false, sessions: [] };
    const sessions: UpdateIdleTerminalSession[] = [];
    for (const value of payload.sessions) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return { available: false, sessions: [] };
      }
      const session = value as Record<string, unknown>;
      const kind = session.kind;
      if (
        typeof session.name !== 'string'
        || (kind !== 'dash-shell' && kind !== 'tmux-attach' && kind !== 'managed-process')
      ) return { available: false, sessions: [] };
      sessions.push({
        name: session.name,
        kind,
        clientCount: typeof session.clientCount === 'number' ? session.clientCount : 0,
        cwd: typeof session.cwd === 'string' ? session.cwd : null,
        commandHint: typeof session.commandHint === 'string' ? session.commandHint : null,
      });
    }
    return { available: true, sessions };
  } catch {
    return { available: false, sessions: [] };
  }
}

export async function getUpdateIdleWindow(): Promise<UpdateIdleWindow> {
  const [terminalInventory, managedRuns, ownedSessions] = await Promise.all([
    readTerminalInventory(),
    listManagedRuns(),
    listOwnedActiveRuns(),
  ]);
  const lanes = listLanes().map((lane) => ({
    id: lane.id,
    label: lane.label,
    status: lane.status,
    runtime: lane.runtime,
    sessionKey: lane.sessionKey,
  }));
  return evaluateUpdateIdleWindow({
    lanes,
    terminalSessions: terminalInventory.sessions,
    terminalInventoryAvailable: terminalInventory.available,
    ownedSessions: ownedSessions.map((session) => ({
      surfaceId: session.surfaceId,
      pid: session.pid ?? null,
      tmuxSession: session.tmuxSession ?? null,
    })),
    managedRuns: managedRuns
      .filter((run) => run.status === 'running')
      .map((run) => ({ id: run.id, session: run.session, command: run.command, cwd: run.cwd })),
  });
}
