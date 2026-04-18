import 'server-only';

import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';
const CLAUDE_BIN = process.env.CLAUDE_BIN || path.join(homedir(), '.local', 'bin', 'claude');
const HISTORY_DIR = path.join(homedir(), '.o8', 'chat-history');
const ARCHIVE_DIR = path.join(homedir(), '.o8', 'orchestrator-archives');
const inFlight = new Map<string, Promise<AutoCompactResult>>();
type PersistedThread = { filePath: string; tabId: string; payload: Record<string, unknown>; messages: MobileTranscriptEntry[]; mtimeMs: number };
export interface AutoCompactResult { applied: boolean; transcript: MobileTranscriptEntry[]; resumePrelude: string | null; tokensAfter: number; }
const fmtStamp = (value: Date) => `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')} ${String(value.getHours()).padStart(2, '0')}:${String(value.getMinutes()).padStart(2, '0')}`;
const approxTokens = (value: string) => Math.max(0, Math.ceil(value.length / 4));
const stripCompactionTags = (value: string) => value.replace(/<\/?compacted_context\b[^>]*>/gi, '').trim();
function coerceEntry(value: unknown): MobileTranscriptEntry | null {
  const record = value as Record<string, unknown> | null;
  const role = record?.role;
  return record && typeof record.id === 'string' && (role === 'user' || role === 'assistant' || role === 'system' || role === 'tool')
    ? { ...(record as unknown as MobileTranscriptEntry), role, text: typeof record.text === 'string' ? record.text : typeof record.content === 'string' ? record.content : '' }
    : null;
}
async function readLatestThread(repoPath: string): Promise<PersistedThread | null> {
  const files = await readdir(HISTORY_DIR).catch(() => [] as string[]);
  const candidates = await Promise.all(files.filter((file) => file.startsWith('thoughts-') && file.endsWith('.json')).map(async (file) => {
    const filePath = path.join(HISTORY_DIR, file);
    const raw = await readFile(filePath, 'utf8').catch(() => '');
    if (!raw) return null;
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return null;
    }
    if ((payload.repoPath as string | undefined)?.trim() !== repoPath) return null;
    const fileStat = await stat(filePath).catch(() => null);
    const messages = Array.isArray(payload.messages) ? payload.messages.map(coerceEntry).filter(Boolean) as MobileTranscriptEntry[] : [];
    return messages.length === 0 || !fileStat ? null : {
      filePath,
      tabId: file.replace(/\.json$/, ''),
      payload,
      messages,
      mtimeMs: fileStat.mtimeMs,
    };
  }));
  return candidates.filter((candidate): candidate is PersistedThread => Boolean(candidate)).sort((left, right) => right.mtimeMs - left.mtimeMs)[0] ?? null;
}
function mergeSnapshots(history: MobileTranscriptEntry[], snapshot: MobileTranscriptEntry[]) {
  if (snapshot.length === 0) return history;
  const next = [...history];
  const seen = new Set(next.map((entry) => entry.id));
  for (const entry of snapshot) {
    const index = next.findIndex((candidate) => candidate.id === entry.id);
    if (index >= 0) {
      next[index] = entry;
      continue;
    }
    if (!seen.has(entry.id)) {
      next.push(entry);
      seen.add(entry.id);
    }
  }
  return next.sort((left, right) => (left.timestamp ?? 0) - (right.timestamp ?? 0));
}
function buildExcerpt(messages: MobileTranscriptEntry[], maxChars: number) {
  let size = 0;
  return messages.map((entry, index) => {
    const role = entry.type === 'compaction' ? 'COMPACTION' : entry.role.toUpperCase();
    const text = (entry.type === 'compaction' ? stripCompactionTags(entry.compaction?.summary ?? entry.text) : entry.text.trim()).slice(0, 1400) || '[no text]';
    const tools = entry.toolCalls?.map((tool) => tool.name).filter(Boolean).join(', ');
    return [`Turn ${index + 1} · ${role}${entry.timestampLabel ? ` · ${entry.timestampLabel}` : ''}`, text, tools ? `Tools: ${tools}` : null].filter(Boolean).join('\n');
  }).filter((chunk) => {
    size += chunk.length;
    return size <= maxChars;
  }).join('\n\n');
}
const toStoredMessage = (entry: MobileTranscriptEntry) => ({ ...entry, content: entry.text });
async function summarizeWithHaiku(repoPath: string, prompt: string) {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(CLAUDE_BIN, ['--print', '--output-format', 'stream-json', '--verbose', '--model', 'haiku', prompt], {
      cwd: repoPath,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
    });
    let buffer = '';
    let stderr = '';
    let result = '';
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          if (parsed.type === 'result' && typeof parsed.result === 'string') result = parsed.result;
        } catch {
          // ignore partial lines
        }
      }
    });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.once('error', reject);
    child.once('close', (code) => {
      const text = result.trim();
      if (code === 0 && text) resolve(text);
      else reject(new Error(stderr.trim() || `Haiku compaction failed (${code ?? 'unknown'})`));
    });
  });
}
export async function autoCompactOrchestratorThread(input: {
  repoPath: string;
  liveMessages?: MobileTranscriptEntry[];
  runningTotal?: number;
  keepTailCount?: number;
  trigger?: 'auto' | 'manual' | 'handoff';
}): Promise<AutoCompactResult> {
  const repoPath = input.repoPath.trim();
  const snapshot = Array.isArray(input.liveMessages) ? input.liveMessages.map(coerceEntry).filter(Boolean) as MobileTranscriptEntry[] : [];
  if (!repoPath) return { applied: false, transcript: snapshot, resumePrelude: null, tokensAfter: 0 };
  const existing = inFlight.get(repoPath);
  if (existing) return existing;
  const job = (async () => {
    const thread = await readLatestThread(repoPath);
    const transcript = mergeSnapshots(thread?.messages ?? [], snapshot);
    if (transcript.length < 2) return { applied: false, transcript, resumePrelude: null, tokensAfter: 0 };
    const keepTailCount = typeof input.keepTailCount === 'number' && Number.isFinite(input.keepTailCount)
      ? Math.max(1, Math.floor(input.keepTailCount))
      : null;
    if (keepTailCount !== null && transcript.length <= keepTailCount + 1) {
      return { applied: false, transcript, resumePrelude: null, tokensAfter: 0 };
    }
    const compactedCount = keepTailCount !== null
      ? Math.max(1, transcript.length - keepTailCount)
      : Math.max(1, Math.floor(transcript.length * 0.6));
    const compactedTurns = transcript.slice(0, compactedCount);
    const liveTurns = transcript.slice(compactedCount);
    const compactedAt = new Date();
    const compactedStamp = fmtStamp(compactedAt);
    const summary = await summarizeWithHaiku(repoPath, ['Summarize this orchestrator thread segment using exactly these sections and terse bullets:', 'Decisions made', 'Files touched', 'Open questions', 'Current mission state', 'Use file paths verbatim. If a section is empty, write "- None."', '', buildExcerpt(compactedTurns, 90_000)].join('\n'));
    const displaySummary = `<compacted_context turns="${compactedCount}" at="${compactedStamp}">\n${summary}\n</compacted_context>`;
    const compactionEntry: MobileTranscriptEntry = {
      id: `orch-compaction-${compactedAt.getTime()}`,
      role: 'system',
      text: 'Context compaction event',
      type: 'compaction',
      timestamp: compactedAt.getTime(),
      timestampLabel: compactedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      compaction: {
        timestamp: compactedAt.getTime(),
        tokensBefore: typeof input.runningTotal === 'number' ? input.runningTotal : undefined,
        tokensAfter: undefined,
        trigger: input.trigger === 'handoff' ? 'manual' : input.trigger ?? 'auto',
        source: 'summary',
        summary: displaySummary,
      },
    };
    const nextTranscript = [compactionEntry, ...liveTurns];
    const resumePrelude = [`Compaction summary (${compactedStamp})`, summary, '', 'Most recent uncompressed turns:', buildExcerpt(liveTurns, 80_000) || '- None.', '', 'Continue from that context. The operator message follows below.'].join('\n');
    const tokensAfter = approxTokens(resumePrelude);
    compactionEntry.compaction!.tokensAfter = tokensAfter;
    await mkdir(ARCHIVE_DIR, { recursive: true });
    await writeFile(path.join(ARCHIVE_DIR, `${thread?.tabId ?? 'thoughts'}-${compactionEntry.id}.json`), JSON.stringify({
      repoPath,
      tabId: thread?.tabId ?? null,
      archivedAt: compactedAt.toISOString(),
      compactedCount,
      turns: compactedTurns.map(toStoredMessage),
      summary,
    }));
    if (thread) {
      await writeFile(thread.filePath, JSON.stringify({ ...thread.payload, messages: nextTranscript.map(toStoredMessage), savedAt: compactedAt.toISOString() }));
    }
    return { applied: true, transcript: nextTranscript, resumePrelude, tokensAfter };
  })().finally(() => {
    inFlight.delete(repoPath);
  });
  inFlight.set(repoPath, job);
  return job;
}
