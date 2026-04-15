import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type {
  MobileTranscriptEntry,
  MobileTranscriptMedia,
  MobileTranscriptSource,
  MobileTranscriptThinkingStep,
  MobileTranscriptToolCall,
} from '@/lib/mobile/types';

const HISTORY_DIR = join(homedir(), '.o8', 'chat-history');

export interface PersistedLlmChatMessage {
  id: string;
  role: MobileTranscriptEntry['role'];
  content: string;
  type?: MobileTranscriptEntry['type'];
  media?: MobileTranscriptMedia[];
  model?: string;
  tokens?: { input: number; output: number };
  costUsd?: number;
  timestamp: number;
  timestampLabel?: string;
  toolCalls?: MobileTranscriptToolCall[];
  sources?: MobileTranscriptSource[];
  thinking?: string;
  thinkingSteps?: MobileTranscriptThinkingStep[];
  thinkingDurationMs?: number;
  isError?: boolean;
  recalledFacts?: number;
  isCompaction?: boolean;
  compactedCount?: number;
  isPartial?: boolean;
  compaction?: MobileTranscriptEntry['compaction'];
}

export interface PersistedLlmChatHistory {
  messages: PersistedLlmChatMessage[];
  model?: string;
  savedAt?: string;
  starred?: boolean;
  title?: string;
  repoName?: string;
  repoPath?: string;
  repoBranch?: string;
  remoteUrl?: string | null;
}

export interface PersistedLlmChatRecord {
  history: PersistedLlmChatHistory;
  modifiedAt: string;
}

function ensureDir() {
  mkdirSync(HISTORY_DIR, { recursive: true });
}

function safePath(tabId: string): string {
  const safe = tabId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return join(HISTORY_DIR, `${safe}.json`);
}

function stripImages(message: PersistedLlmChatMessage): PersistedLlmChatMessage {
  return {
    ...message,
    content: typeof message.content === 'string'
      ? message.content.replace(/!\[[^\]]*\]\(data:[^)]+\)/g, '[image]')
      : message.content,
  };
}

export function readPersistedLlmChat(tabId: string): PersistedLlmChatRecord | null {
  const filePath = safePath(tabId);
  try {
    const raw = readFileSync(filePath, 'utf-8');
    const stat = statSync(filePath);
    const history = JSON.parse(raw) as PersistedLlmChatHistory;
    if (!Array.isArray(history.messages)) return null;
    return {
      history,
      modifiedAt: stat.mtime.toISOString(),
    };
  } catch {
    return null;
  }
}

export function writePersistedLlmChat(tabId: string, history: PersistedLlmChatHistory) {
  ensureDir();
  const filePath = safePath(tabId);
  let starred = false;
  let title: string | undefined;
  try {
    const existing = JSON.parse(readFileSync(filePath, 'utf-8')) as PersistedLlmChatHistory;
    starred = existing.starred || false;
    title = existing.title;
  } catch {
    // no existing history
  }

  writeFileSync(filePath, JSON.stringify({
    ...history,
    messages: history.messages.map(stripImages),
    savedAt: new Date().toISOString(),
    starred: history.starred ?? starred,
    title: history.title ?? title,
  }));
}

export function deletePersistedLlmChat(tabId: string) {
  const filePath = safePath(tabId);
  try {
    if (existsSync(filePath)) unlinkSync(filePath);
  } catch {
    // ignore
  }
}

export function listPersistedLlmChats() {
  try {
    if (!existsSync(HISTORY_DIR)) return [];
    return readdirSync(HISTORY_DIR)
      .filter((file) => file.endsWith('.json'))
      .map((file) => file.replace(/\.json$/, ''));
  } catch {
    return [];
  }
}

export function mapLlmHistoryToMobileTranscript(messages: PersistedLlmChatMessage[], limit?: number): MobileTranscriptEntry[] {
  const filtered = messages
    .filter((message) => !message.isPartial)
    .slice(limit ? -limit : undefined);

  return filtered.map((message) => ({
    id: message.id,
    role: message.role,
    text: message.content,
    type: message.type ?? (message.compaction || message.isCompaction ? 'compaction' : 'message'),
    media: message.media,
    timestamp: message.timestamp,
    timestampLabel: message.timestampLabel ?? (message.timestamp
      ? new Date(message.timestamp).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
      : ''),
    model: message.model,
    tokens: message.tokens,
    costUsd: message.costUsd,
    toolCalls: message.toolCalls,
    sources: message.sources,
    thinking: message.thinking,
    thinkingSteps: message.thinkingSteps,
    thinkingDurationMs: message.thinkingDurationMs,
    recalledFacts: message.recalledFacts,
    compaction: message.compaction,
  }));
}
