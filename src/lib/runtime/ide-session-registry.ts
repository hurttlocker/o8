import path from 'node:path';
import { isCodexSessionLive } from '@/lib/codex/live-sessions';
import {
  listCurrentIdeRepoPaths,
  readIdeTerminalStateFiles,
  type PersistedTabState,
} from '@/lib/runtime/ide-terminal-state';
import { ORCHESTRATOR_RUNTIMES } from '@/lib/orchestrator/runtime-capabilities';

export interface IdeRuntimeSessionDescriptor {
  tabId: string;
  runtimeId: 'codex' | 'claude-code';
  sessionKey: string;
  liveSessionKey?: string;
  label: string;
  model?: string;
  repoName?: string;
  repoPath?: string;
  supervisorStatus?: string | null;
  scope: string;
  savedAt?: string;
  isCurrentSession: boolean;
}

function canonicalizeSessionKey(runtime: 'codex' | 'claude-code', raw: string) {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (runtime === 'codex' && (
    trimmed.startsWith('codex:')
    || trimmed.startsWith('codex-owned:')
    || trimmed.startsWith('codex-discovered:')
    || trimmed.startsWith('codex-live:')
  )) {
    return trimmed;
  }
  return trimmed.startsWith(`${runtime}:`) ? trimmed : `${runtime}:${trimmed}`;
}

function syntheticSessionKey(runtime: 'codex' | 'claude-code', scope: string, tabId: string) {
  return `${runtime}:ide-tab-${scope}-${tabId}`;
}

function scopePriority(scope: string) {
  if (scope.startsWith('repo-')) return 3;
  if (scope === 'tile-root') return 2;
  return 1;
}

function descriptorIdentityKey(session: IdeRuntimeSessionDescriptor) {
  if (session.liveSessionKey) {
    return session.liveSessionKey;
  }
  const repoKey = session.repoPath?.trim().toLowerCase()
    || session.repoName?.trim().toLowerCase()
    || 'no-repo';
  return `ghost:${session.runtimeId}:${repoKey}:${session.label.trim().toLowerCase()}`;
}

function scoreLabel(label: string) {
  const trimmed = label.trim();
  if (!trimmed) return 0;
  if (/^issue #\d+/i.test(trimmed) || /^pr #\d+/i.test(trimmed)) return 3;
  if (/^[a-z0-9_-]+$/i.test(trimmed) && trimmed.length < 12) return 1;
  if (/^codex$/i.test(trimmed) || /^claude code$/i.test(trimmed)) return 1;
  return 2;
}

function runtimeDisplayName(runtime: 'codex' | 'claude-code') {
  // runtime is a strict subset of OrchestratorRuntime — direct map access is safe (no ?.needed).
  return ORCHESTRATOR_RUNTIMES[runtime].label;
}

function repoDisplayName(repoName?: string, repoPath?: string) {
  if (repoName?.trim()) return repoName.trim();
  if (repoPath?.trim()) return path.basename(repoPath.trim());
  return null;
}

function decorateLabel(runtime: 'codex' | 'claude-code', label: string, repoName?: string, repoPath?: string) {
  const trimmed = label.trim();
  const runtimeName = runtimeDisplayName(runtime);
  if (!trimmed) {
    const repoLabel = repoDisplayName(repoName, repoPath);
    return repoLabel ? `${repoLabel} · ${runtimeName}` : runtimeName;
  }

  if (/^issue #\d+/i.test(trimmed) || /^pr #\d+/i.test(trimmed)) {
    return trimmed;
  }

  if (trimmed.toLowerCase() === runtimeName.toLowerCase()) {
    const repoLabel = repoDisplayName(repoName, repoPath);
    return repoLabel ? `${repoLabel} · ${runtimeName}` : runtimeName;
  }

  return trimmed;
}

export function listIdeRuntimeTabs(): IdeRuntimeSessionDescriptor[] {
  const currentRepoPaths = new Set(listCurrentIdeRepoPaths());
  const descriptors = new Map<string, IdeRuntimeSessionDescriptor>();
  const files = readIdeTerminalStateFiles();

  for (const file of files) {
    try {
      const parsed = {
        activeTabId: file.activeTabId,
        tabs: file.tabs,
        savedAt: file.savedAt,
      } satisfies PersistedTabState;
      const scope = file.scope;
      for (const tab of parsed.tabs ?? []) {
        if (tab.kind !== 'chat') continue;
        if (tab.chatRuntime !== 'codex' && tab.chatRuntime !== 'claude-code') continue;
        if (!tab.id?.trim()) continue;

        const liveSessionKey = tab.chatSessionKey
          ? canonicalizeSessionKey(tab.chatRuntime, tab.chatSessionKey)
          : null;

        // #545 root fix — drop codex ghost tabs whose underlying session
        // has been dead beyond the stale window. Claude Code tabs pass
        // through because there is no equivalent liveness registry.
        if (liveSessionKey && tab.chatRuntime === 'codex' && !isCodexSessionLive(liveSessionKey)) {
          continue;
        }

        const sessionKey = liveSessionKey ?? syntheticSessionKey(tab.chatRuntime, scope, tab.id);

        const next: IdeRuntimeSessionDescriptor = {
          tabId: tab.id,
          runtimeId: tab.chatRuntime,
          sessionKey,
          liveSessionKey: liveSessionKey ?? undefined,
          label: decorateLabel(tab.chatRuntime, tab.label?.trim() || runtimeDisplayName(tab.chatRuntime), tab.repoName, tab.repoPath),
          model: tab.chatModel,
          repoName: tab.repoName,
          repoPath: tab.repoPath,
          supervisorStatus: tab.supervisorStatus,
          scope,
          savedAt: parsed.savedAt,
          isCurrentSession: parsed.activeTabId === tab.id,
        };

        const identityKey = descriptorIdentityKey(next);
        const existing = descriptors.get(identityKey);
        if (!existing) {
          descriptors.set(identityKey, next);
          continue;
        }

        const existingScore = scoreLabel(existing.label);
        const nextScore = scoreLabel(next.label);
        const existingTime = existing.savedAt ? new Date(existing.savedAt).getTime() : 0;
        const nextTime = next.savedAt ? new Date(next.savedAt).getTime() : 0;
        const existingScope = scopePriority(existing.scope);
        const nextScope = scopePriority(next.scope);
        if (next.isCurrentSession && !existing.isCurrentSession) {
          descriptors.set(identityKey, next);
          continue;
        }
        if (next.liveSessionKey && !existing.liveSessionKey) {
          descriptors.set(identityKey, next);
          continue;
        }
        if (!next.liveSessionKey && existing.liveSessionKey) {
          continue;
        }
        if (nextScope > existingScope) {
          descriptors.set(identityKey, next);
          continue;
        }

        if (nextScore > existingScore || (nextScore === existingScore && nextTime >= existingTime)) {
          descriptors.set(identityKey, next);
        }
      }
    } catch {
      continue;
    }
  }

  return [...descriptors.values()]
    .filter((session) => {
      if (currentRepoPaths.size === 0) return true;
      const repoPath = session.repoPath?.trim();
      const normalizedRepoPath = repoPath ? path.normalize(repoPath).toLowerCase() : null;
      if (!normalizedRepoPath) return false;
      return currentRepoPaths.has(normalizedRepoPath);
    })
    .sort((left, right) => {
      if (left.isCurrentSession && !right.isCurrentSession) return -1;
      if (!left.isCurrentSession && right.isCurrentSession) return 1;
      const leftTime = left.savedAt ? new Date(left.savedAt).getTime() : 0;
      const rightTime = right.savedAt ? new Date(right.savedAt).getTime() : 0;
      return rightTime - leftTime;
    });
}

export function listIdeRuntimeSessions(): IdeRuntimeSessionDescriptor[] {
  return listIdeRuntimeTabs().filter((session) => Boolean(session.liveSessionKey));
}
