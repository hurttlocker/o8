import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { NextRequest, NextResponse } from 'next/server';
import { mapLlmHistoryToMobileTranscript, readPersistedLlmChat } from '@/lib/llm/chat-history-store';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import { requirePanelAuth } from '@/lib/panel/auth';
import { resolveRepoPathFromRegistry } from '@/lib/repos/repo-path-registry';
import { getDataDir } from '@/lib/data-dir-migration';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ARCHIVE_DIR = path.join(getDataDir(), 'orchestrator-archives');

function normalizeText(value: string) {
  return value.replace(/\s+/g, ' ').trim();
}

function entryText(entry: MobileTranscriptEntry) {
  const base = entry.type === 'compaction'
    ? entry.compaction?.summary ?? entry.text
    : entry.text;
  const tools = (entry.toolCalls ?? [])
    .map((tool) => {
      const args = tool.args ? JSON.stringify(tool.args) : '';
      const preview = typeof tool.preview === 'string' ? tool.preview : '';
      const result = typeof tool.result === 'string' ? tool.result : '';
      return [tool.name, args, preview, result].filter(Boolean).join(' ');
    })
    .filter(Boolean)
    .join(' ');
  return normalizeText([base, tools].filter(Boolean).join(' '));
}

function queryTokens(value: string) {
  return normalizeText(value).toLowerCase().split(/\s+/).filter(Boolean);
}

function scoreEntry(entry: MobileTranscriptEntry, query: string, tokens: string[]) {
  const haystack = entryText(entry).toLowerCase();
  if (!haystack) return 0;

  let score = 0;
  if (haystack.includes(query)) score += 80;
  for (const token of tokens) {
    if (haystack.includes(token)) score += 18;
  }
  if (tokens.length > 1 && tokens.every((token) => haystack.includes(token))) {
    score += 28;
  }
  return score;
}

function previewEntry(entry: MobileTranscriptEntry) {
  const text = entryText(entry);
  return text.length > 160 ? `${text.slice(0, 159).trimEnd()}…` : text;
}

function coerceArchiveEntry(value: unknown): MobileTranscriptEntry | null {
  const record = value as Record<string, unknown> | null;
  const role = record?.role;
  if (
    !record
    || typeof record.id !== 'string'
    || (role !== 'user' && role !== 'assistant' && role !== 'system' && role !== 'tool')
  ) {
    return null;
  }
  return {
    ...(record as unknown as MobileTranscriptEntry),
    role,
    text: typeof record.text === 'string'
      ? record.text
      : typeof record.content === 'string'
        ? record.content
        : '',
  };
}

function matchedWindow(entries: MobileTranscriptEntry[], index: number) {
  const start = Math.max(0, index - 1);
  const end = Math.min(entries.length, index + 2);
  return entries.slice(start, end);
}

async function searchThreadHistory(repoPath: string, query: string, limit: number) {
  const files = await readdir(path.join(getDataDir(), 'chat-history')).catch(() => [] as string[]);
  const matches: Array<{
    id: string;
    score: number;
    source: 'thread';
    tabId: string | null;
    archivedAt: string | null;
    preview: string;
    entries: MobileTranscriptEntry[];
  }> = [];
  const tokens = queryTokens(query);
  const normalizedQuery = normalizeText(query).toLowerCase();

  for (const file of files) {
    if (!file.startsWith('thoughts-') || !file.endsWith('.json')) continue;
    const tabId = file.replace(/\.json$/, '');
    const history = readPersistedLlmChat(tabId)?.history;
    if (!history?.messages?.length) continue;
    if ((history.repoPath ?? '').trim().replace(/\/+$/, '') !== repoPath) continue;

    const transcript = mapLlmHistoryToMobileTranscript(history.messages);
    transcript.forEach((entry, index) => {
      const score = scoreEntry(entry, normalizedQuery, tokens);
      if (score <= 0) return;
      matches.push({
        id: `${tabId}:${entry.id}`,
        score,
        source: 'thread',
        tabId,
        archivedAt: history.savedAt ?? null,
        preview: previewEntry(entry),
        entries: matchedWindow(transcript, index),
      });
    });
  }

  return matches
    .sort((left, right) => right.score - left.score || String(right.archivedAt ?? '').localeCompare(String(left.archivedAt ?? '')))
    .slice(0, limit);
}

async function searchCompactionArchives(repoPath: string, query: string, limit: number) {
  const files = await readdir(ARCHIVE_DIR).catch(() => [] as string[]);
  const matches: Array<{
    id: string;
    score: number;
    source: 'compaction';
    tabId: string | null;
    archivedAt: string | null;
    preview: string;
    entries: MobileTranscriptEntry[];
  }> = [];
  const tokens = queryTokens(query);
  const normalizedQuery = normalizeText(query).toLowerCase();

  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const raw = await readFile(path.join(ARCHIVE_DIR, file), 'utf8').catch(() => '');
    if (!raw) continue;

    let payload: {
      repoPath?: string;
      tabId?: string | null;
      archivedAt?: string | null;
      turns?: unknown[];
    };
    try {
      payload = JSON.parse(raw) as typeof payload;
    } catch {
      continue;
    }

    if ((payload.repoPath ?? '').trim().replace(/\/+$/, '') !== repoPath) continue;
    const entries = Array.isArray(payload.turns)
      ? payload.turns.map((turn) => coerceArchiveEntry(turn)).filter((turn): turn is MobileTranscriptEntry => turn !== null)
      : [];
    entries.forEach((entry, index) => {
      const score = scoreEntry(entry, normalizedQuery, tokens);
      if (score <= 0) return;
      matches.push({
        id: `${file}:${entry.id}`,
        score,
        source: 'compaction',
        tabId: payload.tabId ?? null,
        archivedAt: payload.archivedAt ?? null,
        preview: previewEntry(entry),
        entries: matchedWindow(entries, index),
      });
    });
  }

  return matches
    .sort((left, right) => right.score - left.score || String(right.archivedAt ?? '').localeCompare(String(left.archivedAt ?? '')))
    .slice(0, limit);
}

export async function GET(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;

  const repoPath = request.nextUrl.searchParams.get('repoPath')?.trim() ?? '';
  const query = request.nextUrl.searchParams.get('q')?.trim() ?? '';
  const archiveRef = request.nextUrl.searchParams.get('ref')?.trim() ?? '';
  const limit = Math.max(1, Math.min(10, Number.parseInt(request.nextUrl.searchParams.get('limit') ?? '5', 10) || 5));
  if (!repoPath || (!query && !archiveRef)) {
    return NextResponse.json({ matches: [] }, { headers: { 'Cache-Control': 'no-store, max-age=0' } });
  }

  const resolved = await resolveRepoPathFromRegistry(repoPath);
  if (!resolved.ok) {
    return NextResponse.json({ matches: [] }, {
      status: resolved.status,
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    });
  }

  if (archiveRef) {
    if (path.basename(archiveRef) !== archiveRef || !archiveRef.endsWith('.json')) {
      return NextResponse.json({ error: 'Invalid archive reference.' }, { status: 400 });
    }
    const raw = await readFile(path.join(ARCHIVE_DIR, archiveRef), 'utf8').catch(() => '');
    if (!raw) return NextResponse.json({ error: 'Archive not found.' }, { status: 404 });
    try {
      const archive = JSON.parse(raw) as Record<string, unknown>;
      if (String(archive.repoPath ?? '').trim().replace(/\/+$/, '') !== resolved.repoRoot) {
        return NextResponse.json({ error: 'Archive not found.' }, { status: 404 });
      }
      return NextResponse.json({ archive: { ref: archiveRef, ...archive } }, {
        headers: { 'Cache-Control': 'no-store, max-age=0' },
      });
    } catch {
      return NextResponse.json({ error: 'Archive is unreadable.' }, { status: 500 });
    }
  }

  const [threadMatches, compactionMatches] = await Promise.all([
    searchThreadHistory(resolved.repoRoot, query, limit),
    searchCompactionArchives(resolved.repoRoot, query, limit),
  ]);

  return NextResponse.json({
    matches: [...threadMatches, ...compactionMatches]
      .sort((left, right) => right.score - left.score || String(right.archivedAt ?? '').localeCompare(String(left.archivedAt ?? '')))
      .slice(0, limit),
  }, {
    headers: { 'Cache-Control': 'no-store, max-age=0' },
  });
}
