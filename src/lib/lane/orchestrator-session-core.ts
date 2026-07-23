import { createHash } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';

export type OrchestratorSessionStatus = 'ready' | 'busy' | 'dead';

export interface OrchestratorSessionCore {
  sessionName: string;
  repoPath: string;
  status: OrchestratorSessionStatus;
  proc: ChildProcess | null;
  createdAt: number;
}

export const PROCESS_TIMEOUT_MS = 14_400_000;
export const PREEMPT_SETTLE_MS = 4_000;

export function orchestratorDataDir(name: string): string {
  return join(getDataDir(), name);
}

export function normalizeRepoPath(repoPath: string): string {
  return resolve(repoPath).replace(/\/+$/, '');
}

export function repoHash(repoPath: string): string {
  return createHash('sha256').update(repoPath).digest('hex').slice(0, 8);
}

export function normalizeThoughtsThreadId(threadId?: string | null): string | null {
  const trimmed = threadId?.trim() ?? '';
  return trimmed.startsWith('thoughts-') ? trimmed : null;
}

export function thoughtsThreadKey(threadId?: string | null): string | null {
  const normalized = normalizeThoughtsThreadId(threadId);
  return normalized ? normalized.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 96) : null;
}

export function sessionNameForRepo(prefix: string, repoPath: string, threadId?: string | null): string {
  const threadSuffix = thoughtsThreadKey(threadId);
  return `${prefix}-${repoHash(normalizeRepoPath(repoPath))}${threadSuffix ? `-${threadSuffix}` : ''}`;
}

export async function waitForSessionIdle(
  session: { status: OrchestratorSessionStatus },
  timeoutMs: number,
): Promise<void> {
  if (session.status !== 'busy') return;
  const deadline = Date.now() + timeoutMs;
  while (session.status === 'busy' && Date.now() < deadline) {
    await new Promise((resolveTick) => setTimeout(resolveTick, 50));
  }
}

export function getRegisteredSession<TSession>(
  sessions: Map<string, TSession>,
  sessionName: string,
): TSession | null {
  return sessions.get(sessionName) ?? null;
}

export function ensureRegisteredSession<TSession extends OrchestratorSessionCore>(
  sessions: Map<string, TSession>,
  params: {
    repoPath: string;
    threadId?: string | null;
    sessionNameFor: (repoPath: string, threadId?: string | null) => string;
    create: (normalizedRepoPath: string, normalizedThreadId: string | null, sessionName: string) => TSession;
    logPrefix: string;
  },
): TSession {
  const normalizedRepoPath = normalizeRepoPath(params.repoPath);
  const normalizedThreadId = normalizeThoughtsThreadId(params.threadId);
  const sessionName = params.sessionNameFor(normalizedRepoPath, normalizedThreadId);
  const existing = sessions.get(sessionName);

  if (existing && existing.status !== 'dead') {
    return existing;
  }

  const session = params.create(normalizedRepoPath, normalizedThreadId, sessionName);
  sessions.set(sessionName, session);
  console.log(`${params.logPrefix} Created ${sessionName} for ${normalizedRepoPath}${normalizedThreadId ? ` (${normalizedThreadId})` : ''}`);
  return session;
}

export function requestRegisteredSessionReset<TSession>(
  sessions: Map<string, TSession>,
  params: {
    repoPath: string;
    threadId?: string | null;
    sessionNameFor: (repoPath: string, threadId?: string | null) => string;
    resetExisting?: (session: TSession, sessionName: string) => void;
    resetPersistedThread?: (threadId: string) => void;
  },
): { repoPath: string; sessionName: string; threadId: string | null } {
  const normalizedRepoPath = normalizeRepoPath(params.repoPath);
  const normalizedThreadId = normalizeThoughtsThreadId(params.threadId);
  const sessionName = params.sessionNameFor(normalizedRepoPath, normalizedThreadId);
  const session = sessions.get(sessionName);
  if (session) {
    params.resetExisting?.(session, sessionName);
  }
  if (normalizedThreadId) {
    params.resetPersistedThread?.(normalizedThreadId);
  }
  return { repoPath: normalizedRepoPath, sessionName, threadId: normalizedThreadId };
}

export function resetSignalPath(stateDir: string, repoPath: string, threadId?: string | null): string {
  const threadSuffix = thoughtsThreadKey(threadId);
  return join(
    stateDir,
    `session-reset-${repoHash(normalizeRepoPath(repoPath))}${threadSuffix ? `-${threadSuffix}` : ''}.json`,
  );
}

export function writeResetSignal(stateDir: string, repoPath: string, threadId?: string | null): void {
  if (!existsSync(stateDir)) {
    mkdirSync(stateDir, { recursive: true });
  }
  writeFileSync(
    resetSignalPath(stateDir, repoPath, threadId),
    `${JSON.stringify({ repoPath: normalizeRepoPath(repoPath), threadId: normalizeThoughtsThreadId(threadId), requestedAt: Date.now() })}\n`,
    'utf8',
  );
}

export function consumeResetSignal(stateDir: string, repoPath: string, threadId?: string | null): boolean {
  const signalPath = resetSignalPath(stateDir, repoPath, threadId);
  if (!existsSync(signalPath)) {
    return false;
  }

  try {
    rmSync(signalPath, { force: true });
    return true;
  } catch {
    return false;
  }
}
