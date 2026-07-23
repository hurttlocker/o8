export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/mobile/search?q=... — universal mobile search.
 *
 * Fans out across three local sources and returns grouped, capped results:
 *   - chats     — ~/.o8/chat-history/mobile-chat-*.json (assistant chats)
 *   - threads   — ~/.o8/chat-history/thoughts-*.json    (orchestrator threads)
 *   - activity  — getMobileInboxSnapshot() events       (inbox items)
 *
 * Each group is capped at MAX_PER_GROUP. Substring (case-insensitive) match —
 * spec says fuzzy is overkill for v1. Empty q returns empty groups; the client
 * shows its LRU "Recent" panel instead.
 */

import { NextRequest, NextResponse } from 'next/server';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { buildErrorPayload } from '@/lib/api/error-format';
import { getMobileInboxSnapshot } from '@/lib/mobile/inbox';
import { getDataDir } from '@/lib/data-dir-migration';

const HISTORY_DIR = join(getDataDir(), 'chat-history');
const MAX_PER_GROUP = 20;
const PREVIEW_LEN = 140;

export type MobileSearchCategory = 'chat' | 'thread' | 'activity';

export interface MobileSearchResult {
  category: MobileSearchCategory;
  id: string;
  title: string;
  preview: string;
  /** ISO string for sorting / display */
  timestamp: string;
  /** Optional metadata for deep-link routing */
  meta?: Record<string, string>;
}

export interface MobileSearchResponse {
  query: string;
  groups: {
    chats: MobileSearchResult[];
    threads: MobileSearchResult[];
    activity: MobileSearchResult[];
  };
  truncated: {
    chats: boolean;
    threads: boolean;
    activity: boolean;
  };
}

function trimPreview(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= PREVIEW_LEN) return normalized;
  return `${normalized.slice(0, PREVIEW_LEN - 3).trim()}...`;
}

function snippetAround(haystack: string, needle: string): string {
  const idx = haystack.toLowerCase().indexOf(needle);
  if (idx < 0) return trimPreview(haystack);
  const start = Math.max(0, idx - 40);
  const slice = haystack.slice(start, start + PREVIEW_LEN);
  return (start > 0 ? '...' : '') + trimPreview(slice);
}

function searchChatHistoryFiles(prefix: 'mobile-chat-' | 'thoughts-', q: string): MobileSearchResult[] {
  const results: MobileSearchResult[] = [];
  let files: string[];
  try {
    files = readdirSync(HISTORY_DIR).filter((file) => file.endsWith('.json') && file.startsWith(prefix));
  } catch {
    return results;
  }

  for (const file of files) {
    try {
      const filePath = join(HISTORY_DIR, file);
      const stat = statSync(filePath);
      const raw = readFileSync(filePath, 'utf-8');
      const data = JSON.parse(raw) as {
        title?: string;
        messages?: Array<{ role?: string; content?: string }>;
        model?: string;
        repoName?: string | null;
        repoPath?: string | null;
        repoBranch?: string | null;
        savedAt?: string;
      };

      // Mobile-chat surface filter — match the same rule as
      // /api/v2/chat-history/list?surface=mobile-assistant so the search
      // result list mirrors the Chats tab.
      if (prefix === 'mobile-chat-') {
        const model = typeof data.model === 'string' ? data.model : '';
        if (model === 'o8-operator' || model === 'claude-code') continue;
      }

      const messages = Array.isArray(data.messages) ? data.messages : [];
      const allText = messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join(' ');
      const titleLower = (data.title ?? '').toLowerCase();
      const repoText = [data.repoName, data.repoPath, data.repoBranch].filter(Boolean).join(' ').toLowerCase();
      const allTextLower = allText.toLowerCase();

      const inTitle = titleLower.includes(q);
      const inBody = allTextLower.includes(q);
      const inRepo = repoText.includes(q);
      if (!inTitle && !inBody && !inRepo) continue;

      const tabId = basename(file, '.json');
      const firstUser = messages.find((m) => m.role === 'user');
      const fallbackTitle = firstUser?.content
        ? trimPreview(firstUser.content).slice(0, 60)
        : 'Untitled';
      const title = (data.title && data.title.trim()) || fallbackTitle;

      // Build a snippet around the first match so the user sees context.
      const preview = inBody
        ? snippetAround(allText, q)
        : inRepo
          ? trimPreview(repoText)
          : trimPreview(messages[messages.length - 1]?.content ?? '');

      const timestamp = data.savedAt ?? stat.mtime.toISOString();

      results.push({
        category: prefix === 'thoughts-' ? 'thread' : 'chat',
        id: tabId,
        title,
        preview,
        timestamp,
        meta: {
          ...(data.repoName ? { repoName: data.repoName } : {}),
          ...(data.repoPath ? { repoPath: data.repoPath } : {}),
          ...(data.model ? { model: data.model } : {}),
        },
      });
    } catch {
      // skip unreadable file
    }
  }

  results.sort((left, right) => new Date(right.timestamp).getTime() - new Date(left.timestamp).getTime());
  return results;
}

async function searchActivity(q: string): Promise<MobileSearchResult[]> {
  let snapshot: Awaited<ReturnType<typeof getMobileInboxSnapshot>>;
  try {
    snapshot = await getMobileInboxSnapshot({ fresh: false });
  } catch {
    return [];
  }

  const results: MobileSearchResult[] = [];
  for (const item of snapshot.items) {
    const titleLower = item.title.toLowerCase();
    const detailLower = (item.detail ?? '').toLowerCase();
    if (!titleLower.includes(q) && !detailLower.includes(q)) continue;

    results.push({
      category: 'activity',
      id: item.id,
      title: item.title,
      preview: trimPreview(item.detail ?? ''),
      timestamp: item.timestampLabel ?? snapshot.generatedAt,
      meta: {
        kind: item.kind,
        severity: item.severity,
        ...(item.sessionKey ? { sessionKey: item.sessionKey } : {}),
        ...(item.approvalId ? { approvalId: item.approvalId } : {}),
      },
    });
  }
  return results;
}

export async function GET(request: NextRequest) {
  const rawQuery = (request.nextUrl.searchParams.get('q') ?? '').trim();
  const query = rawQuery.toLowerCase();

  if (!query) {
    const empty: MobileSearchResponse = {
      query: '',
      groups: { chats: [], threads: [], activity: [] },
      truncated: { chats: false, threads: false, activity: false },
    };
    return NextResponse.json(empty, {
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    });
  }

  try {
    const [chatsAll, threadsAll, activityAll] = await Promise.all([
      Promise.resolve(searchChatHistoryFiles('mobile-chat-', query)),
      Promise.resolve(searchChatHistoryFiles('thoughts-', query)),
      searchActivity(query),
    ]);

    const chats = chatsAll.slice(0, MAX_PER_GROUP);
    const threads = threadsAll.slice(0, MAX_PER_GROUP);
    const activity = activityAll.slice(0, MAX_PER_GROUP);

    const payload: MobileSearchResponse = {
      query: rawQuery,
      groups: { chats, threads, activity },
      truncated: {
        chats: chatsAll.length > MAX_PER_GROUP,
        threads: threadsAll.length > MAX_PER_GROUP,
        activity: activityAll.length > MAX_PER_GROUP,
      },
    };

    return NextResponse.json(payload, {
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    });
  } catch (error) {
    console.log('[mobile-search] failed', error);
    return NextResponse.json(
      buildErrorPayload('Failed to run mobile search.', error),
      { status: 500, headers: { 'Cache-Control': 'no-store, max-age=0' } },
    );
  }
}
