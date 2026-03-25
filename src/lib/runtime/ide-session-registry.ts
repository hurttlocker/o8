import 'server-only';

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

type PersistedChatRuntime = 'codex' | 'claude-code' | 'openclaw';

type PersistedTab = {
  id?: string;
  label?: string;
  kind?: 'terminal' | 'chat' | 'llm-chat';
  chatRuntime?: PersistedChatRuntime;
  chatSessionKey?: string;
  chatModel?: string;
  repoName?: string;
  repoPath?: string;
};

type PersistedTabState = {
  tabs?: PersistedTab[];
  savedAt?: string;
};

export interface IdeRuntimeSessionDescriptor {
  runtimeId: 'codex' | 'claude-code';
  sessionKey: string;
  label: string;
  model?: string;
  repoName?: string;
  repoPath?: string;
  scope: string;
  savedAt?: string;
}

const TERMINAL_STATE_DIR = path.join(homedir(), '.cortex-ide', 'terminal-states');

function canonicalizeSessionKey(runtime: 'codex' | 'claude-code', raw: string) {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return trimmed.startsWith(`${runtime}:`) ? trimmed : `${runtime}:${trimmed}`;
}

function scoreLabel(label: string) {
  const trimmed = label.trim();
  if (!trimmed) return 0;
  if (/^issue #\d+/i.test(trimmed) || /^pr #\d+/i.test(trimmed)) return 3;
  if (/^[a-z0-9_-]+$/i.test(trimmed) && trimmed.length < 12) return 1;
  if (/^codex$/i.test(trimmed) || /^claude code$/i.test(trimmed)) return 1;
  return 2;
}

export function listIdeRuntimeSessions(): IdeRuntimeSessionDescriptor[] {
  if (!existsSync(TERMINAL_STATE_DIR)) return [];

  const descriptors = new Map<string, IdeRuntimeSessionDescriptor>();
  const files = readdirSync(TERMINAL_STATE_DIR).filter((file) => file.endsWith('.json'));

  for (const file of files) {
    const filePath = path.join(TERMINAL_STATE_DIR, file);
    try {
      const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as PersistedTabState;
      const scope = file.replace(/\.json$/, '');
      for (const tab of parsed.tabs ?? []) {
        if (tab.kind !== 'chat') continue;
        if (tab.chatRuntime !== 'codex' && tab.chatRuntime !== 'claude-code') continue;
        if (!tab.chatSessionKey) continue;

        const sessionKey = canonicalizeSessionKey(tab.chatRuntime, tab.chatSessionKey);
        if (!sessionKey) continue;

        const next: IdeRuntimeSessionDescriptor = {
          runtimeId: tab.chatRuntime,
          sessionKey,
          label: tab.label?.trim() || (tab.chatRuntime === 'codex' ? 'Codex' : 'Claude Code'),
          model: tab.chatModel,
          repoName: tab.repoName,
          repoPath: tab.repoPath,
          scope,
          savedAt: parsed.savedAt,
        };

        const existing = descriptors.get(sessionKey);
        if (!existing) {
          descriptors.set(sessionKey, next);
          continue;
        }

        const existingScore = scoreLabel(existing.label);
        const nextScore = scoreLabel(next.label);
        const existingTime = existing.savedAt ? new Date(existing.savedAt).getTime() : 0;
        const nextTime = next.savedAt ? new Date(next.savedAt).getTime() : 0;

        if (nextScore > existingScore || (nextScore === existingScore && nextTime >= existingTime)) {
          descriptors.set(sessionKey, next);
        }
      }
    } catch {
      continue;
    }
  }

  return [...descriptors.values()].sort((left, right) => {
    const leftTime = left.savedAt ? new Date(left.savedAt).getTime() : 0;
    const rightTime = right.savedAt ? new Date(right.savedAt).getTime() : 0;
    return rightTime - leftTime;
  });
}
