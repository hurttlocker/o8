import 'server-only';

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';

import type Database from 'better-sqlite3';

import { codename } from '@/lib/agents/codename';
import { getSqlite } from '@/lib/db';
import type { RuntimeSession } from '@/lib/runtimes/types';
import {
  type AgentPresence,
  findAgentPresence,
  listAgentPresence,
  upsertAgentPresence,
} from './store';

const execFileAsync = promisify(execFile);
const LIVE_MESSAGE_RUNTIMES = new Set(['claude-code', 'codex']);

export interface LiveAgentPresenceSeams {
  discoverSessions: () => Promise<RuntimeSession[]>;
  resolveRepoPath: (cwd: string) => Promise<string | null>;
  now: () => Date;
}

async function discoverLiveMessageSessions(): Promise<RuntimeSession[]> {
  const { getRuntime } = await import('@/lib/runtimes');
  const runtimeIds = ['claude-code', 'codex'] as const;
  const runtimes = runtimeIds
    .map((runtimeId) => getRuntime(runtimeId))
    .filter((runtime) => Boolean(runtime));
  const results = await Promise.allSettled(runtimes.map((runtime) => runtime!.discoverSessions()));
  return results.flatMap((result) => result.status === 'fulfilled' ? result.value : []);
}

export async function resolveSessionRepoPath(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
      { windowsHide: true, timeout: 2_000 },
    );
    const commonDir = path.resolve(cwd, stdout.trim());
    return path.basename(commonDir) === '.git' ? path.dirname(commonDir) : null;
  } catch {
    return null;
  }
}

export const defaultLiveAgentPresenceSeams: LiveAgentPresenceSeams = {
  discoverSessions: discoverLiveMessageSessions,
  resolveRepoPath: resolveSessionRepoPath,
  now: () => new Date(),
};

export function liveSessionAgentId(session: Pick<RuntimeSession, 'runtimeId' | 'sessionKey'>): string {
  const sessionKey = session.sessionKey.startsWith(`${session.runtimeId}:`)
    ? session.sessionKey
    : `${session.runtimeId}:${session.sessionKey}`;
  return `session:${sessionKey}`;
}

export function availableAutomaticAgentName(
  agentId: string,
  repo: string,
  sqlite: Database.Database,
): string {
  const existing = findAgentPresence({ agentId }, sqlite);
  if (existing?.repo === repo) return existing.name;

  const base = codename(agentId);
  const collision = listAgentPresence(repo, { includeStale: true }, sqlite)
    .find((presence) => presence.name.toLowerCase() === base.toLowerCase());
  if (!collision || collision.agentId === agentId) return base;
  return `${base}-${createHash('sha256').update(agentId).digest('hex').slice(0, 6)}`;
}

function isAddressableSession(session: RuntimeSession): boolean {
  return LIVE_MESSAGE_RUNTIMES.has(session.runtimeId)
    && session.status === 'running'
    && session.sessionCapabilities.canSendInput
    && Boolean(session.sessionKey.trim())
    && Boolean(session.cwd.trim());
}

interface ResolvedLiveSession {
  session: RuntimeSession;
  repo: string | null;
}

async function resolveLiveMessageSessions(
  seams: LiveAgentPresenceSeams,
): Promise<ResolvedLiveSession[]> {
  let sessions: RuntimeSession[];
  try {
    sessions = await seams.discoverSessions();
  } catch (error) {
    console.warn('[agent-presence] Live runtime discovery failed:', error instanceof Error ? error.message : String(error));
    return [];
  }

  const seenSessionKeys = new Set<string>();
  const candidates = sessions.filter((session) => {
    if (!isAddressableSession(session)) return false;
    const identityKey = `${session.runtimeId}:${session.sessionKey}`;
    if (seenSessionKeys.has(identityKey)) return false;
    seenSessionKeys.add(identityKey);
    return true;
  });
  const repoByCwd = new Map<string, Promise<string | null>>();
  for (const session of candidates) {
    if (!repoByCwd.has(session.cwd)) {
      repoByCwd.set(session.cwd, seams.resolveRepoPath(session.cwd).catch(() => null));
    }
  }
  return Promise.all(candidates.map(async (session) => ({
    session,
    repo: await repoByCwd.get(session.cwd)!,
  })));
}

export async function reconcileLiveAgentPresence(
  repo: string,
  seams: LiveAgentPresenceSeams = defaultLiveAgentPresenceSeams,
  sqlite: Database.Database = getSqlite(),
): Promise<AgentPresence[]> {
  const normalizedRepo = path.resolve(repo).replace(/\/+$/, '');
  const reconciled: AgentPresence[] = [];
  for (const { session, repo: sessionRepo } of await resolveLiveMessageSessions(seams)) {
    if (!sessionRepo || path.resolve(sessionRepo).replace(/\/+$/, '') !== normalizedRepo) continue;
    const agentId = liveSessionAgentId(session);
    reconciled.push(upsertAgentPresence({
      agentId,
      name: availableAutomaticAgentName(agentId, normalizedRepo, sqlite),
      repo: normalizedRepo,
      worktreePath: path.resolve(session.cwd),
      runtime: session.runtimeId,
      sessionKey: session.sessionKey,
      laneId: null,
      packetId: null,
      lastSeen: seams.now().toISOString(),
    }, sqlite));
  }

  return reconciled;
}

export async function reconcileAllLiveAgentPresence(
  seams: LiveAgentPresenceSeams = defaultLiveAgentPresenceSeams,
  sqlite: Database.Database = getSqlite(),
): Promise<AgentPresence[]> {
  const reconciled: AgentPresence[] = [];
  for (const { session, repo } of await resolveLiveMessageSessions(seams)) {
    if (!repo) continue;
    const normalizedRepo = path.resolve(repo).replace(/\/+$/, '');
    const agentId = liveSessionAgentId(session);
    reconciled.push(upsertAgentPresence({
      agentId,
      name: availableAutomaticAgentName(agentId, normalizedRepo, sqlite),
      repo: normalizedRepo,
      worktreePath: path.resolve(session.cwd),
      runtime: session.runtimeId,
      sessionKey: session.sessionKey,
      laneId: null,
      packetId: null,
      lastSeen: seams.now().toISOString(),
    }, sqlite));
  }
  return reconciled;
}
