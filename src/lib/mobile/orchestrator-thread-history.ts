import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { readdir as readdirAsync, stat as statAsync } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';
import { isOrchestratorBackendId } from '@/lib/lane/orchestrator-backends/types';
import type { MobileOrchestratorBackend, MobileOrchestratorThread } from '@/lib/mobile/types';
import { stableOrchestratorThreadTitleForId } from '@/lib/orchestrator/thread-title';
import { resolveRepoGithubIdentity } from '@/lib/repos/github-identity';

export const ORCHESTRATOR_HISTORY_DIR = join(homedir(), '.o8', 'chat-history');
const MAX_THREADS = 20;
const DEFAULT_MODEL = 'claude-code';
const DEFAULT_BACKEND: MobileOrchestratorBackend = 'claude';

export interface OrchestratorThreadRevealRequest {
  requestedAt: string;
  thread: MobileOrchestratorThread;
}

type ChatHistoryMessage = {
  id?: string;
  role?: string;
  content?: string;
  timestamp?: number;
  // Task #8 — monotonic per-message persist version, bumped on every write of
  // this message (incremental mid-stream persists included). The client's
  // history merge compares versions instead of blind ID-membership replaces,
  // so a stale fetch can never revert a completed answer to a partial one.
  persistedVersion?: number;
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
  orchestratorTerminalStatus?: 'failed' | null;
  orchestratorTerminalError?: string | null;
  orchestratorTerminalAt?: string | null;
  orchestratorSessionIds?: Record<string, string | null>;
  orchestratorSessionUpdatedAt?: string | null;
};

type OrchestratorHistoryFileStat = {
  file: string;
  filePath: string;
  tabId: string;
  mtimeMs: number;
  size: number;
  modifiedAt: string;
};

type CachedHistoryRecord = {
  mtimeMs: number;
  size: number;
  parsed: OrchestratorHistoryRecord;
};

const historyParseCache = new Map<string, CachedHistoryRecord>();
let historyWriteVersion = 0;

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

/**
 * Read a thread's persisted transcript as an ordered user/assistant message
 * array — the context the free `o8` orchestrator backend replays to the gateway
 * each turn (it holds no session of its own). Empty (never null) when the thread
 * has no file yet or no usable turns. Reads straight from disk so it reflects
 * the user message ws-server persists just before calling the backend.
 */
export function readOrchestratorThreadMessages(
  tabId: string | null | undefined,
): Array<{ role: 'user' | 'assistant'; content: string }> {
  if (!tabId) return [];
  const record = readHistoryRecord(tabId);
  if (!record?.messages) return [];
  const out: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const message of record.messages) {
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    if (typeof message.content !== 'string' || message.content.trim().length === 0) continue;
    out.push({ role: message.role, content: message.content });
  }
  return out;
}

function writeHistoryRecord(tabId: string, record: OrchestratorHistoryRecord) {
  ensureHistoryDir();
  const filePath = safeOrchestratorHistoryPath(tabId);
  writeFileSync(filePath, JSON.stringify(record));
  historyParseCache.delete(filePath);
  historyWriteVersion += 1;
}

// Marker so the one-time transcript-order repair runs once per install.
const TRANSCRIPT_REPAIR_MARKER = join(homedir(), '.o8', '.transcript-order-repaired-v1');
// Pre-v0.1.229, ws-server froze the assistant timestamp at turn START — a
// millisecond BEFORE the user message was persisted — so timestamp-sorted
// transcripts rendered the reply above the question. The inverted pair sits
// 0-1ms apart, while a genuine reply→next-question boundary is minutes apart,
// so an adjacent [assistant→user] pair inside this window is unambiguously a
// flipped turn (the live scan found the nearest real boundary ~40min away).
const TRANSCRIPT_FLIP_GAP_MS = 5000;

/**
 * One-time, marker-gated repair of transcripts flipped by the pre-v0.1.229
 * assistant-timestamp bug. Swaps the inverted [assistant, user] pair's
 * timestamps so the question precedes the reply, then rewrites the file in
 * corrected order. Idempotent and never throws — safe to call on every boot;
 * after the marker lands it returns immediately. The persistence-layer clamp
 * in upsertMobileOrchestratorAssistantMessage prevents new flips, so this only
 * heals history written before the fix shipped.
 */
export function repairFlippedOrchestratorTranscripts(): void {
  try {
    if (existsSync(TRANSCRIPT_REPAIR_MARKER)) return;
    let files: string[] = [];
    try {
      files = readdirSync(ORCHESTRATOR_HISTORY_DIR).filter((file) => file.endsWith('.json'));
    } catch {
      files = [];
    }
    let fixedThreads = 0;
    let fixedPairs = 0;
    for (const file of files) {
      const fullPath = join(ORCHESTRATOR_HISTORY_DIR, file);
      let record: OrchestratorHistoryRecord | null;
      try {
        record = JSON.parse(readFileSync(fullPath, 'utf-8')) as OrchestratorHistoryRecord;
      } catch {
        continue;
      }
      if (!record || !Array.isArray(record.messages)) continue;
      // Walk in render order (timestamp-sorted); the message objects are shared
      // with record.messages (shallow slice), so swapping their timestamps here
      // lands on the stored record.
      const sorted = record.messages.slice().sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
      let changed = false;
      for (let i = 0; i < sorted.length - 1; i += 1) {
        const reply = sorted[i];
        const prompt = sorted[i + 1];
        if (
          reply.role === 'assistant'
          && prompt.role === 'user'
          && typeof reply.timestamp === 'number'
          && typeof prompt.timestamp === 'number'
        ) {
          const gap = prompt.timestamp - reply.timestamp;
          if (gap >= 0 && gap < TRANSCRIPT_FLIP_GAP_MS) {
            const tmp = reply.timestamp;
            reply.timestamp = prompt.timestamp;
            prompt.timestamp = tmp;
            changed = true;
            fixedPairs += 1;
          }
        }
      }
      if (changed) {
        record.messages = record.messages
          .slice()
          .sort((x, y) => (x.timestamp ?? 0) - (y.timestamp ?? 0));
        try {
          writeFileSync(fullPath, JSON.stringify(record));
          fixedThreads += 1;
        } catch {
          // best-effort per file
        }
      }
    }
    try {
      writeFileSync(TRANSCRIPT_REPAIR_MARKER, new Date().toISOString());
    } catch {
      // best-effort marker; a failed write just means we retry next boot (idempotent)
    }
    if (fixedPairs > 0) {
      console.log(`[transcript-repair] fixed ${fixedPairs} flipped turn(s) across ${fixedThreads} thread(s)`);
    }
  } catch (err) {
    console.warn('[transcript-repair] skipped:', err);
  }
}

function normalizeSessionIds(value: unknown): Record<string, string | null> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const normalized: Record<string, string | null> = {};
  for (const [key, rawSessionId] of Object.entries(value as Record<string, unknown>)) {
    if (!key) continue;
    if (rawSessionId === null) {
      normalized[key] = null;
      continue;
    }
    if (typeof rawSessionId !== 'string') continue;
    const sessionId = rawSessionId.trim();
    if (sessionId) normalized[key] = sessionId;
  }
  return normalized;
}

function normalizeBackend(value: unknown): MobileOrchestratorBackend | null {
  return isOrchestratorBackendId(value) ? value : null;
}

function normalizeAgent(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 128) : null;
}

function normalizeErrorMessage(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 500) : null;
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

function inferBackendFromSessionIds(record: OrchestratorHistoryRecord): MobileOrchestratorBackend | null {
  const sessionIds = normalizeSessionIds(record.orchestratorSessionIds);
  if (sessionIds.claude) return 'claude';
  if (sessionIds.codex) return 'codex';
  return null;
}

function modelForBackend(backend: MobileOrchestratorBackend | null): string | null {
  if (backend === 'claude') return 'claude-code';
  if (backend === 'codex') return 'codex';
  if (backend === 'openclaw') return 'openclaw';
  if (backend === 'hermes') return 'hermes';
  return null;
}

function effectiveBackend(record: OrchestratorHistoryRecord): MobileOrchestratorBackend | null {
  return normalizeBackend(record.backend) ?? inferBackendFromSessionIds(record);
}

function effectiveModel(tabId: string, record: OrchestratorHistoryRecord): string | null {
  if (typeof record.model === 'string' && record.model.trim()) return record.model.trim();
  const backendModel = modelForBackend(effectiveBackend(record));
  if (backendModel) return backendModel;
  return tabId.startsWith('thoughts-') ? DEFAULT_MODEL : null;
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
  const lastMessage = messages[messages.length - 1];
  const fallbackTitle = stableOrchestratorThreadTitleForId(tabId, record.savedAt || modifiedAt);
  const repoPath = typeof record.repoPath === 'string' ? record.repoPath : null;
  const githubIdentity = resolveRepoGithubIdentity(repoPath, record.remoteUrl);
  // "Last spoke", not "last touched" (Q ruling 2026-07-16): savedAt restamps
  // on every persist — merely OPENING a thread re-persisted it and bumped it
  // to the top of every recency-ordered rail. The newest message timestamp is
  // the truthful recency; savedAt/mtime only for empty or pre-timestamp files.
  const lastSpokeMs = messages.reduce((max, m) => (
    Number.isFinite(m?.timestamp) && (m.timestamp as number) > max ? (m.timestamp as number) : max
  ), 0);

  return {
    id: tabId,
    title: trimTitle(record.title, fallbackTitle),
    lastMessageAt: lastSpokeMs > 0 ? new Date(lastSpokeMs).toISOString() : (record.savedAt || modifiedAt),
    runtime: inferRuntime(effectiveModel(tabId, record)),
    status: record.orchestratorTerminalStatus === 'failed'
      ? 'failed'
      : messages.length === 0 ? 'idle' : lastMessage?.role === 'user' ? 'busy' : 'ready',
    messageCount: messages.length,
    repoPath,
    repoName: typeof record.repoName === 'string' && record.repoName.trim()
      ? record.repoName
      : repoNameFromPath(repoPath),
    repoBranch: typeof record.repoBranch === 'string' ? record.repoBranch : null,
    githubOwner: githubIdentity.githubOwner,
    githubRepo: githubIdentity.githubRepo,
    backend: effectiveBackend(record),
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

function listThoughtHistoryFileStats(): OrchestratorHistoryFileStat[] {
  if (!existsSync(ORCHESTRATOR_HISTORY_DIR)) {
    historyParseCache.clear();
    return [];
  }

  const stats: OrchestratorHistoryFileStat[] = [];
  const livePaths = new Set<string>();
  const files = readdirSync(ORCHESTRATOR_HISTORY_DIR)
    .filter((file) => file.endsWith('.json'))
    .sort();
  for (const file of files) {
    const tabId = basename(file, '.json');
    if (!tabId.startsWith('thoughts-')) continue;
    try {
      const filePath = join(ORCHESTRATOR_HISTORY_DIR, file);
      const stat = statSync(filePath);
      livePaths.add(filePath);
      stats.push({
        file,
        filePath,
        tabId,
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        modifiedAt: stat.mtime.toISOString(),
      });
    } catch {
      // skip files that moved during the scan
    }
  }

  for (const filePath of historyParseCache.keys()) {
    if (!livePaths.has(filePath)) historyParseCache.delete(filePath);
  }
  return stats;
}

function readCachedHistoryRecord(fileStat: OrchestratorHistoryFileStat): OrchestratorHistoryRecord {
  const cached = historyParseCache.get(fileStat.filePath);
  if (cached && cached.mtimeMs === fileStat.mtimeMs && cached.size === fileStat.size) {
    return cached.parsed;
  }

  const parsed = JSON.parse(readFileSync(fileStat.filePath, 'utf-8')) as OrchestratorHistoryRecord;
  historyParseCache.set(fileStat.filePath, {
    mtimeMs: fileStat.mtimeMs,
    size: fileStat.size,
    parsed,
  });
  return parsed;
}

export function mobileOrchestratorThreadHistoryStatToken(): string {
  const fileToken = listThoughtHistoryFileStats()
    .map((fileStat) => `${fileStat.file}:${fileStat.mtimeMs}:${fileStat.size}`)
    .join('|');
  return `${historyWriteVersion}:${fileToken}`;
}

// Async mirror of listThoughtHistoryFileStats for the ws-server's 1Hz poll,
// which runs on the event loop that streams agent output — the sync version's
// readdirSync + per-file statSync blocked that loop every second. Same
// filtering, sorting, and parse-cache eviction; only the fs calls are async.
async function listThoughtHistoryFileStatsAsync(): Promise<OrchestratorHistoryFileStat[]> {
  let entries: string[];
  try {
    entries = await readdirAsync(ORCHESTRATOR_HISTORY_DIR);
  } catch {
    // Dir absent/unreadable — mirror the sync path's !existsSync branch.
    historyParseCache.clear();
    return [];
  }

  const stats: OrchestratorHistoryFileStat[] = [];
  const livePaths = new Set<string>();
  const files = entries.filter((file) => file.endsWith('.json')).sort();
  for (const file of files) {
    const tabId = basename(file, '.json');
    if (!tabId.startsWith('thoughts-')) continue;
    try {
      const filePath = join(ORCHESTRATOR_HISTORY_DIR, file);
      const stat = await statAsync(filePath);
      livePaths.add(filePath);
      stats.push({
        file,
        filePath,
        tabId,
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        modifiedAt: stat.mtime.toISOString(),
      });
    } catch {
      // skip files that moved during the scan
    }
  }

  for (const filePath of historyParseCache.keys()) {
    if (!livePaths.has(filePath)) historyParseCache.delete(filePath);
  }
  return stats;
}

// Async form of mobileOrchestratorThreadHistoryStatToken — identical token
// value, no sync fs. Used by the 1Hz ws-server poll.
export async function mobileOrchestratorThreadHistoryStatTokenAsync(): Promise<string> {
  const fileToken = (await listThoughtHistoryFileStatsAsync())
    .map((fileStat) => `${fileStat.file}:${fileStat.mtimeMs}:${fileStat.size}`)
    .join('|');
  return `${historyWriteVersion}:${fileToken}`;
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
  const backendFilter = options.backend ?? null;
  const limit = options.limit ?? MAX_THREADS;
  const threads: MobileOrchestratorThread[] = [];

  for (const fileStat of listThoughtHistoryFileStats()) {
    try {
      const record = readCachedHistoryRecord(fileStat);
      // Archived threads are off the active list — the operator archived them to
      // declutter; they must not reappear in the orchestrator history/past-thread
      // surfaces (which is where they were leaking back in).
      if (record.archivedAt) continue;
      const threadBackend = effectiveBackend(record);
      if (backendFilter ? threadBackend !== backendFilter : threadBackend === 'openclaw') {
        continue;
      }
      threads.push(projectThread(fileStat.tabId, record, fileStat.modifiedAt));
    } catch {
      // skip unreadable files
    }
  }

  threads.sort((left, right) => (
    new Date(right.lastMessageAt).getTime() - new Date(left.lastMessageAt).getTime()
  ));
  return threads.slice(0, limit);
}

/**
 * The `thoughts-*` ids the operator has archived (record.archivedAt set).
 *
 * The restore pipeline cross-references this so an archived thread's persisted
 * workspace tab does NOT resurrect on reload — archiving removes the thread from
 * the active surfaces and the tab must follow. Unlike listMobileOrchestratorThreads
 * this has NO recency cap and ignores the backend split: it returns EVERY
 * archived id so the client only ever drops genuinely-archived tabs (a top-20
 * or backend-filtered live list would false-positive and strip valid tabs).
 */
export function listArchivedOrchestratorThreadIds(): string[] {
  const ids: string[] = [];
  if (!existsSync(ORCHESTRATOR_HISTORY_DIR)) return ids;

  let files: string[] = [];
  try {
    files = readdirSync(ORCHESTRATOR_HISTORY_DIR).filter((file) => file.endsWith('.json'));
  } catch {
    return ids;
  }

  for (const file of files) {
    const tabId = basename(file, '.json');
    if (!tabId.startsWith('thoughts-')) continue;
    try {
      const record = JSON.parse(
        readFileSync(join(ORCHESTRATOR_HISTORY_DIR, file), 'utf-8'),
      ) as OrchestratorHistoryRecord;
      if (record.archivedAt) ids.push(tabId);
    } catch {
      // skip unreadable files
    }
  }
  return ids;
}

export function createMobileOrchestratorThread(input: {
  repoPath: string;
  title?: string | null;
  repoName?: string | null;
  repoBranch?: string | null;
  backend?: MobileOrchestratorBackend | null;
  agent?: string | null;
  reveal?: boolean;
}): MobileOrchestratorThread {
  const repoPath = input.repoPath.trim();
  if (!repoPath) {
    throw new Error('repoPath is required');
  }

  const now = new Date().toISOString();
  const tabId = nextThreadId();
  const backend = input.backend ?? DEFAULT_BACKEND;
  const record: OrchestratorHistoryRecord = {
    messages: [],
    model: modelForBackend(backend) ?? DEFAULT_MODEL,
    savedAt: now,
    starred: false,
    pinned: false,
    title: trimTitle(input.title, 'New chat'),
    repoPath,
    repoName: trimTitle(input.repoName, repoNameFromPath(repoPath) ?? 'Project'),
    repoBranch: typeof input.repoBranch === 'string' && input.repoBranch.trim() ? input.repoBranch.trim() : null,
    remoteUrl: null,
    backend,
    agent: normalizeAgent(input.agent),
    archivedAt: null,
    orchestratorVisible: true,
    mobileCreatedAt: now,
    mobileRevealRequestedAt: input.reveal === false ? null : now,
    orchestratorTerminalStatus: null,
    orchestratorTerminalError: null,
    orchestratorTerminalAt: null,
    orchestratorSessionIds: {},
    orchestratorSessionUpdatedAt: null,
  };

  writeHistoryRecord(tabId, record);
  return projectThread(tabId, record, now);
}

export function appendMobileOrchestratorUserMessage(input: {
  tabId: string | null | undefined;
  repoPath: string;
  message: string;
  backend?: MobileOrchestratorBackend | null;
  agent?: string | null;
  timestampMs?: number;
}): MobileOrchestratorThread | null {
  const tabId = input.tabId;
  if (!tabId?.startsWith('thoughts-')) return null;

  const content = input.message.trim();
  if (!content) return readProjectedThread(tabId);

  const timestamp = typeof input.timestampMs === 'number' && Number.isFinite(input.timestampMs)
    ? input.timestampMs
    : Date.now();
  const now = new Date(timestamp);
  const nowIso = now.toISOString();
  const existing = readHistoryRecord(tabId) ?? {
    messages: [],
    savedAt: nowIso,
    model: modelForBackend(input.backend ?? DEFAULT_BACKEND) ?? DEFAULT_MODEL,
    starred: false,
    pinned: false,
    title: null,
    repoPath: input.repoPath,
    repoName: repoNameFromPath(input.repoPath),
    backend: input.backend ?? DEFAULT_BACKEND,
    agent: normalizeAgent(input.agent),
    archivedAt: null,
    orchestratorVisible: true,
    orchestratorSessionIds: {},
    orchestratorSessionUpdatedAt: null,
  };
  const messages = Array.isArray(existing.messages) ? existing.messages : [];
  const last = messages[messages.length - 1];
  const alreadyLastUserMessage = last?.role === 'user' && last.content === content;
  const nextMessages = alreadyLastUserMessage
    ? messages
    : [
      ...messages,
      {
        id: `user-${now.getTime()}`,
        role: 'user',
        content,
        timestamp,
      },
    ];

  writeHistoryRecord(tabId, {
    ...existing,
    messages: nextMessages,
    model: existing.model ?? modelForBackend(input.backend ?? DEFAULT_BACKEND) ?? DEFAULT_MODEL,
    savedAt: nowIso,
    title: typeof existing.title === 'string' && existing.title.trim() ? existing.title.trim() : null,
    repoPath: typeof existing.repoPath === 'string' && existing.repoPath.trim()
      ? existing.repoPath
      : input.repoPath,
    repoName: typeof existing.repoName === 'string' && existing.repoName.trim()
      ? existing.repoName
      : repoNameFromPath(input.repoPath),
    backend: normalizeBackend(existing.backend) ?? input.backend ?? DEFAULT_BACKEND,
    agent: normalizeAgent(input.agent) ?? normalizeAgent(existing.agent),
    orchestratorTerminalStatus: null,
    orchestratorTerminalError: null,
    orchestratorTerminalAt: null,
    mobileRevealRequestedAt: existing.mobileRevealRequestedAt ?? null,
    orchestratorVisible: true,
  });

  return readProjectedThread(tabId);
}

export function upsertMobileOrchestratorAssistantMessage(input: {
  tabId: string | null | undefined;
  repoPath: string;
  messageId: string;
  content: string;
  backend?: MobileOrchestratorBackend | null;
  agent?: string | null;
  sessionId?: string | null;
  model?: string | null;
  timestampMs?: number;
}): MobileOrchestratorThread | null {
  const tabId = input.tabId;
  if (!tabId?.startsWith('thoughts-')) return null;

  const content = input.content;
  if (!content || !content.trim()) return null;

  const existing = readHistoryRecord(tabId);
  if (!existing) {
    // The user-message helper writes the record first. If it's missing here,
    // we skip rather than orphan an assistant-only record on disk.
    return null;
  }

  const now = new Date();
  const nowIso = now.toISOString();
  const messages = Array.isArray(existing.messages) ? existing.messages : [];
  // The caller (ws-server) freezes the assistant timestamp at turn START, which
  // can be a millisecond BEFORE the user message is persisted — that inverts the
  // pair so the timestamp-sorted transcript renders the reply above the question
  // (#transcript-flip). Clamp the assistant strictly after the most recent
  // existing message (the user it's answering) so the turn always reads in order.
  const baseTimestamp = typeof input.timestampMs === 'number' ? input.timestampMs : now.getTime();
  const lastTimestamp = messages.length > 0 ? (messages[messages.length - 1]?.timestamp ?? 0) : 0;
  const timestamp = Math.max(baseTimestamp, lastTimestamp + 1);

  const existingIndex = messages.findIndex((m) => m?.id === input.messageId);
  let nextMessages: ChatHistoryMessage[];
  if (existingIndex >= 0) {
    nextMessages = messages.slice();
    nextMessages[existingIndex] = {
      ...nextMessages[existingIndex],
      role: 'assistant',
      content,
      persistedVersion: (nextMessages[existingIndex]?.persistedVersion ?? 0) + 1,
    };
  } else {
    // Defensive: if the most recent assistant message has identical content,
    // a full chat client likely POSTed the same turn already. Don't append a
    // duplicate; just refresh metadata via the savedAt write below.
    const last = messages[messages.length - 1];
    if (last?.role === 'assistant' && last.content === content) {
      nextMessages = messages;
    } else {
      nextMessages = [
        ...messages,
        {
          id: input.messageId,
          role: 'assistant',
          content,
          timestamp,
          persistedVersion: 1,
        },
      ];
    }
  }

  const explicitBackend = normalizeBackend(input.backend);
  const nextBackend = explicitBackend
    ?? normalizeBackend(existing.backend)
    ?? inferBackendFromSessionIds(existing)
    ?? DEFAULT_BACKEND;

  const nextSessionIds = normalizeSessionIds(existing.orchestratorSessionIds);
  let sessionIdsTouched = false;
  if ((nextBackend === 'claude' || nextBackend === 'codex')
    && typeof input.sessionId === 'string'
    && input.sessionId.trim()
  ) {
    const trimmed = input.sessionId.trim();
    if (nextSessionIds[nextBackend] !== trimmed) {
      nextSessionIds[nextBackend] = trimmed;
      sessionIdsTouched = true;
    }
  }

  const explicitModel = typeof input.model === 'string' && input.model.trim()
    ? input.model.trim()
    : null;
  const nextModel = explicitModel
    ?? (typeof existing.model === 'string' && existing.model.trim() ? existing.model.trim() : null)
    ?? modelForBackend(nextBackend)
    ?? DEFAULT_MODEL;

  writeHistoryRecord(tabId, {
    ...existing,
    messages: nextMessages,
    model: nextModel,
    backend: nextBackend,
    agent: normalizeAgent(input.agent) ?? normalizeAgent(existing.agent),
    orchestratorTerminalStatus: null,
    orchestratorTerminalError: null,
    orchestratorTerminalAt: null,
    savedAt: nowIso,
    repoPath: typeof existing.repoPath === 'string' && existing.repoPath.trim()
      ? existing.repoPath
      : input.repoPath,
    repoName: typeof existing.repoName === 'string' && existing.repoName.trim()
      ? existing.repoName
      : repoNameFromPath(input.repoPath),
    orchestratorSessionIds: nextSessionIds,
    orchestratorSessionUpdatedAt: sessionIdsTouched ? nowIso : existing.orchestratorSessionUpdatedAt ?? null,
    orchestratorVisible: existing.orchestratorVisible === false ? false : true,
  });

  return readProjectedThread(tabId);
}

export function markMobileOrchestratorThreadFailed(input: {
  tabId: string | null | undefined;
  repoPath: string;
  error: string;
  backend?: MobileOrchestratorBackend | null;
  agent?: string | null;
  timestampMs?: number;
}): MobileOrchestratorThread | null {
  const tabId = input.tabId;
  if (!tabId?.startsWith('thoughts-')) return null;
  const now = new Date(
    typeof input.timestampMs === 'number' && Number.isFinite(input.timestampMs)
      ? input.timestampMs
      : Date.now(),
  ).toISOString();
  const existing = readHistoryRecord(tabId) ?? {
    messages: [],
    savedAt: now,
    model: modelForBackend(input.backend ?? DEFAULT_BACKEND) ?? DEFAULT_MODEL,
    starred: false,
    pinned: false,
    title: null,
    repoPath: input.repoPath,
    repoName: repoNameFromPath(input.repoPath),
    backend: input.backend ?? DEFAULT_BACKEND,
    agent: normalizeAgent(input.agent),
    archivedAt: null,
    orchestratorVisible: true,
    orchestratorSessionIds: {},
    orchestratorSessionUpdatedAt: null,
  };

  writeHistoryRecord(tabId, {
    ...existing,
    messages: Array.isArray(existing.messages) ? existing.messages : [],
    model: existing.model ?? modelForBackend(input.backend ?? DEFAULT_BACKEND) ?? DEFAULT_MODEL,
    savedAt: now,
    repoPath: typeof existing.repoPath === 'string' && existing.repoPath.trim()
      ? existing.repoPath
      : input.repoPath,
    repoName: typeof existing.repoName === 'string' && existing.repoName.trim()
      ? existing.repoName
      : repoNameFromPath(input.repoPath),
    backend: normalizeBackend(existing.backend) ?? input.backend ?? DEFAULT_BACKEND,
    agent: normalizeAgent(input.agent) ?? normalizeAgent(existing.agent),
    orchestratorTerminalStatus: 'failed',
    orchestratorTerminalError: normalizeErrorMessage(input.error) ?? 'Orchestrator failed.',
    orchestratorTerminalAt: now,
    orchestratorVisible: true,
  });

  return readProjectedThread(tabId);
}

export function readOrchestratorBackendSessionId(
  tabId: string | null | undefined,
  backend: 'claude' | 'codex',
): string | null {
  if (!tabId?.startsWith('thoughts-')) return null;
  const record = readHistoryRecord(tabId);
  if (!record) return null;
  const sessionIds = normalizeSessionIds(record.orchestratorSessionIds);
  const sessionId = sessionIds[backend];
  return typeof sessionId === 'string' && sessionId.trim() ? sessionId.trim() : null;
}

export function writeOrchestratorBackendSessionId(
  tabId: string | null | undefined,
  backend: 'claude' | 'codex',
  sessionId: string | null,
): void {
  if (!tabId?.startsWith('thoughts-')) return;
  const now = new Date().toISOString();
  const existing = readHistoryRecord(tabId) ?? { messages: [], savedAt: now };
  const nextSessionIds = normalizeSessionIds(existing.orchestratorSessionIds);
  if (sessionId?.trim()) {
    nextSessionIds[backend] = sessionId.trim();
  } else {
    delete nextSessionIds[backend];
  }
  writeHistoryRecord(tabId, {
    ...existing,
    messages: Array.isArray(existing.messages) ? existing.messages : [],
    model: existing.model ?? modelForBackend(backend) ?? DEFAULT_MODEL,
    savedAt: existing.savedAt ?? now,
    backend: normalizeBackend(existing.backend) ?? backend,
    orchestratorSessionIds: nextSessionIds,
    orchestratorSessionUpdatedAt: now,
  });
}

export function clearOrchestratorBackendSessionIds(tabId: string | null | undefined): void {
  if (!tabId?.startsWith('thoughts-')) return;
  const existing = readHistoryRecord(tabId);
  if (!existing) return;
  writeHistoryRecord(tabId, {
    ...existing,
    orchestratorSessionIds: {},
    orchestratorSessionUpdatedAt: new Date().toISOString(),
  });
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
