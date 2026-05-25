import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';
import type { MobileOrchestratorBackend, MobileOrchestratorThread } from '@/lib/mobile/types';

export const ORCHESTRATOR_HISTORY_DIR = join(homedir(), '.o8', 'chat-history');
const MAX_THREADS = 20;
const DEFAULT_MODEL = 'claude-code';

export interface OrchestratorThreadRevealRequest {
  requestedAt: string;
  thread: MobileOrchestratorThread;
}

type ChatHistoryMessage = {
  role?: string;
  content?: string;
};

type OrchestratorHistoryRecord = {
  messages?: ChatHistoryMessage[];
  model?: string | null;
  savedAt?: string | null;
  title?: string | null;
  repoPath?: string | null;
  repoName?: string | null;
  repoBranch?: string | null;
  remoteUrl?: string | null;
  backend?: string | null;
  agent?: string | null;
  archivedAt?: string | null;
  starred?: boolean;
  pinned?: boolean;
  orchestratorVisible?: boolean;
  mobileCreatedAt?: string | null;
  mobileRevealRequestedAt?: string | null;
};

function ensureHistoryDir() {
  mkdirSync(ORCHESTRATOR_HISTORY_DIR, { recursive: true });
}

export function safeOrchestratorHistoryPath(tabId: string): string {
  const safe = tabId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return join(ORCHESTRATOR_HISTORY_DIR, `${safe}.json`);
}

function readHistoryRecord(tabId: string): OrchestratorHistoryRecord | null {
  try {
    return JSON.parse(readFileSync(safeOrchestratorHistoryPath(tabId), 'utf-8')) as OrchestratorHistoryRecord;
  } catch {
    return null;
  }
}

function writeHistoryRecord(tabId: string, record: OrchestratorHistoryRecord) {
  ensureHistoryDir();
  writeFileSync(safeOrchestratorHistoryPath(tabId), JSON.stringify(record));
}

function normalizeBackend(value: unknown): MobileOrchestratorBackend | null {
  return value === 'openclaw' || value === 'codex' || value === 'claude' ? value : null;
}

function normalizeAgent(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 128) : null;
}

function inferRuntime(model: string | undefined | null): MobileOrchestratorThread['runtime'] {
  if (!model) return 'unknown';
  const lower = model.toLowerCase();
  if (lower.includes('claude')) return 'claude-code';
  if (lower.includes('gemini')) return 'gemini';
  if (lower.includes('opencode')) return 'opencode';
  if (lower.includes('codex') || lower.startsWith('gpt')) return 'codex';
  return 'unknown';
}

function trimTitle(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  return trimmed.slice(0, 80);
}

function repoNameFromPath(repoPath: string | null): string | null {
  if (!repoPath) return null;
  const name = basename(repoPath.replace(/[/\\]+$/, ''));
  return name || null;
}

function projectThread(
  tabId: string,
  record: OrchestratorHistoryRecord,
  modifiedAt: string,
): MobileOrchestratorThread {
  const messages = Array.isArray(record.messages) ? record.messages : [];
  const firstUserMessage = messages.find((message) => message.role === 'user');
  const lastMessage = messages[messages.length - 1];
  const fallbackTitle = firstUserMessage?.content
    ? firstUserMessage.content.slice(0, 60).replace(/\n/g, ' ') + (firstUserMessage.content.length > 60 ? '...' : '')
    : 'New chat';

  return {
    id: tabId,
    title: trimTitle(record.title, fallbackTitle),
    lastMessageAt: record.savedAt || modifiedAt,
    runtime: inferRuntime(record.model),
    status: messages.length === 0 ? 'idle' : lastMessage?.role === 'user' ? 'busy' : 'ready',
    messageCount: messages.length,
    repoPath: typeof record.repoPath === 'string' ? record.repoPath : null,
    repoName: typeof record.repoName === 'string' && record.repoName.trim()
      ? record.repoName
      : repoNameFromPath(typeof record.repoPath === 'string' ? record.repoPath : null),
    repoBranch: typeof record.repoBranch === 'string' ? record.repoBranch : null,
    backend: normalizeBackend(record.backend),
    agent: normalizeAgent(record.agent),
    pinned: record.pinned === true,
  };
}

function readProjectedThread(tabId: string): MobileOrchestratorThread | null {
  const record = readHistoryRecord(tabId);
  if (!record) return null;
  try {
    const stat = statSync(safeOrchestratorHistoryPath(tabId));
    return projectThread(tabId, record, stat.mtime.toISOString());
  } catch {
    return projectThread(tabId, record, new Date().toISOString());
  }
}

function nextThreadId(): string {
  let candidate = `thoughts-${Date.now()}`;
  let suffix = 0;
  while (existsSync(safeOrchestratorHistoryPath(candidate))) {
    suffix += 1;
    candidate = `thoughts-${Date.now()}-${suffix}`;
  }
  return candidate;
}

export function listMobileOrchestratorThreads(options: {
  backend?: MobileOrchestratorBackend | null;
  limit?: number;
} = {}): MobileOrchestratorThread[] {
  const wantOpenclaw = options.backend === 'openclaw';
  const limit = options.limit ?? MAX_THREADS;
  const threads: MobileOrchestratorThread[] = [];
  if (!existsSync(ORCHESTRATOR_HISTORY_DIR)) return threads;

  const files = readdirSync(ORCHESTRATOR_HISTORY_DIR).filter((file) => file.endsWith('.json'));
  for (const file of files) {
    const tabId = basename(file, '.json');
    if (!tabId.startsWith('thoughts-')) continue;

    try {
      const filePath = join(ORCHESTRATOR_HISTORY_DIR, file);
      const stat = statSync(filePath);
      const record = JSON.parse(readFileSync(filePath, 'utf-8')) as OrchestratorHistoryRecord;
      const threadBackend = normalizeBackend(record.backend);
      if (wantOpenclaw ? threadBackend !== 'openclaw' : threadBackend === 'openclaw') {
        continue;
      }
      threads.push(projectThread(tabId, record, stat.mtime.toISOString()));
    } catch {
      // skip unreadable files
    }
  }

  threads.sort((left, right) => (
    new Date(right.lastMessageAt).getTime() - new Date(left.lastMessageAt).getTime()
  ));
  return threads.slice(0, limit);
}

export function createMobileOrchestratorThread(input: {
  repoPath: string;
  title?: string | null;
  repoName?: string | null;
  repoBranch?: string | null;
  reveal?: boolean;
}): MobileOrchestratorThread {
  const repoPath = input.repoPath.trim();
  if (!repoPath) {
    throw new Error('repoPath is required');
  }

  const now = new Date().toISOString();
  const tabId = nextThreadId();
  const record: OrchestratorHistoryRecord = {
    messages: [],
    model: DEFAULT_MODEL,
    savedAt: now,
    starred: false,
    pinned: false,
    title: trimTitle(input.title, 'New chat'),
    repoPath,
    repoName: trimTitle(input.repoName, repoNameFromPath(repoPath) ?? 'Project'),
    repoBranch: typeof input.repoBranch === 'string' && input.repoBranch.trim() ? input.repoBranch.trim() : null,
    remoteUrl: null,
    backend: null,
    agent: null,
    archivedAt: null,
    orchestratorVisible: true,
    mobileCreatedAt: now,
    mobileRevealRequestedAt: input.reveal === false ? null : now,
  };

  writeHistoryRecord(tabId, record);
  return projectThread(tabId, record, now);
}

export function requestMobileOrchestratorReveal(tabId: string): OrchestratorThreadRevealRequest | null {
  if (!tabId.startsWith('thoughts-')) return null;
  const record = readHistoryRecord(tabId);
  if (!record) return null;
  const now = new Date().toISOString();
  writeHistoryRecord(tabId, {
    ...record,
    orchestratorVisible: true,
    mobileRevealRequestedAt: now,
  });
  const thread = readProjectedThread(tabId);
  return thread ? { requestedAt: now, thread } : null;
}

export function listMobileOrchestratorRevealRequests(since: string | null): OrchestratorThreadRevealRequest[] {
  const sinceMs = since ? Date.parse(since) : 0;
  const requests: OrchestratorThreadRevealRequest[] = [];
  if (!existsSync(ORCHESTRATOR_HISTORY_DIR)) return requests;
  const files = readdirSync(ORCHESTRATOR_HISTORY_DIR).filter((file) => file.endsWith('.json'));

  for (const file of files) {
    const tabId = basename(file, '.json');
    if (!tabId.startsWith('thoughts-')) continue;
    try {
      const filePath = join(ORCHESTRATOR_HISTORY_DIR, file);
      const stat = statSync(filePath);
      const record = JSON.parse(readFileSync(filePath, 'utf-8')) as OrchestratorHistoryRecord;
      const requestedAt = typeof record.mobileRevealRequestedAt === 'string' ? record.mobileRevealRequestedAt : null;
      if (!requestedAt) continue;
      const requestedMs = Date.parse(requestedAt);
      if (!Number.isFinite(requestedMs) || requestedMs <= sinceMs) continue;
      requests.push({
        requestedAt,
        thread: projectThread(tabId, record, stat.mtime.toISOString()),
      });
    } catch {
      // skip unreadable files
    }
  }

  requests.sort((left, right) => Date.parse(left.requestedAt) - Date.parse(right.requestedAt));
  return requests.slice(-10);
}
