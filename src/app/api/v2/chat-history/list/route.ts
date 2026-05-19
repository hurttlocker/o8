export const dynamic = 'force-dynamic';

/**
 * GET /api/v2/chat-history/list — List all saved LLM chat conversations
 * Optional: ?q=search for full-text search across conversations
 *
 * Returns: { conversations: ChatHistoryEntry[] }
 */

import { NextRequest, NextResponse } from 'next/server';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';

const HISTORY_DIR = join(homedir(), '.o8', 'chat-history');

interface ChatHistoryEntry {
  tabId: string;
  title: string;
  preview: string;
  empty: boolean;
  messageCount: number;
  model: string;
  savedAt: string;
  modifiedAt: string;
  starred: boolean;
  pinned: boolean;
  planText?: string | null;
  firstUserMessage?: string | null;
  repoName?: string | null;
  repoPath?: string | null;
  repoBranch?: string | null;
  remoteUrl?: string | null;
  archivedAt?: string | null;
}

export async function GET(request: NextRequest) {
  const searchQuery = request.nextUrl.searchParams.get('q')?.toLowerCase();
  const includeOrchestrator = request.nextUrl.searchParams.get('include') === 'orchestrator';
  const archivedParam = request.nextUrl.searchParams.get('archived');
  const includeArchived = archivedParam === 'include' || archivedParam === 'true' || archivedParam === '1';
  const onlyArchived = archivedParam === 'only';
  // surface=mobile-assistant restricts the list to mobile-chat-* files where
  // the model is NOT an orchestrator brand. The mobile Assistant tab uses
  // this so desktop LLM tabs (llm-*), orchestrator threads (thoughts-*),
  // legacy mobile-orchestrator-*, and o8-operator-modeled files don't
  // pollute the conversations list.
  const surface = request.nextUrl.searchParams.get('surface');
  const isMobileAssistantOnly = surface === 'mobile-assistant';

  try {
    const files = readdirSync(HISTORY_DIR).filter(f => f.endsWith('.json'));
    const conversations: ChatHistoryEntry[] = [];

    for (const file of files) {
      try {
        const filePath = join(HISTORY_DIR, file);
        const stat = statSync(filePath);
        const raw = readFileSync(filePath, 'utf-8');
        const data = JSON.parse(raw);

        if (!data.messages) continue;

        // Skip orchestrator threads unless explicitly requested
        const tabId = basename(file, '.json');
        if (!includeOrchestrator && tabId.startsWith('thoughts-')) continue;

        if (isMobileAssistantOnly) {
          // Only mobile-chat-* files for the mobile Assistant tab.
          if (!tabId.startsWith('mobile-chat-')) continue;
          // Skip any file whose model brand reads as orchestrator (the
          // o8-operator brand string is the orchestrator label) so even
          // a mistitled mobile-chat- file with that model gets excluded.
          const model = typeof data.model === 'string' ? data.model : '';
          if (model === 'o8-operator' || model === 'claude-code') continue;
        }

        const messages = (data.messages ?? []) as { role: string; content: string }[];
        const firstUserMsg = messages.find(m => m.role === 'user');
        const lastMsg = messages[messages.length - 1];
        const isEmpty = messages.length === 0;
        const archivedAt = typeof data.archivedAt === 'string' && data.archivedAt.trim()
          ? data.archivedAt
          : null;
        const staleEmptyThread = isEmpty && Date.now() - stat.mtime.getTime() > 24 * 60 * 60 * 1000;
        if (onlyArchived) {
          if (!archivedAt) continue;
        } else if (!includeArchived && (archivedAt || staleEmptyThread)) {
          continue;
        }

        // Placeholder title for empty threads (created via + New but not typed into yet).
        // Gets replaced by the first user message once the operator types.
        const placeholderTitle = (() => {
          const saved = data.savedAt ? new Date(data.savedAt) : stat.birthtime ?? stat.mtime;
          const hh = String(saved.getHours()).padStart(2, '0');
          const mm = String(saved.getMinutes()).padStart(2, '0');
          return `New thread · ${hh}:${mm}`;
        })();

        const title = data.title || (firstUserMsg
          ? firstUserMsg.content.slice(0, 60).replace(/\n/g, ' ') + (firstUserMsg.content.length > 60 ? '...' : '')
          : isEmpty ? placeholderTitle : 'Untitled conversation');

        // Preview from last message (empty threads show nothing).
        const preview = lastMsg
          ? lastMsg.content.slice(0, 100).replace(/\n/g, ' ') + (lastMsg.content.length > 100 ? '...' : '')
          : '';

        // Full-text search
        if (searchQuery) {
          const allText = messages.map(m => m.content).join(' ').toLowerCase();
          const repoText = [data.repoName, data.repoPath, data.repoBranch].filter(Boolean).join(' ').toLowerCase();
          if (!allText.includes(searchQuery) && !title.toLowerCase().includes(searchQuery) && !repoText.includes(searchQuery)) {
            continue;
          }
        }

        conversations.push({
          tabId: basename(file, '.json'),
          title,
          preview,
          empty: isEmpty,
          messageCount: messages.length,
          model: data.model || 'unknown',
          savedAt: data.savedAt || stat.mtime.toISOString(),
          modifiedAt: stat.mtime.toISOString(),
          starred: data.starred || false,
          pinned: data.pinned === true,
          planText: typeof data.planText === 'string' && data.planText.trim() ? data.planText : null,
          firstUserMessage: firstUserMsg ? firstUserMsg.content.slice(0, 500) : null,
          repoName: data.repoName || null,
          repoPath: data.repoPath || null,
          repoBranch: data.repoBranch || null,
          remoteUrl: data.remoteUrl || null,
          archivedAt,
        });
      } catch { /* skip bad files */ }
    }

    // Sort: pinned/starred first, then by date descending.
    conversations.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      if (a.starred !== b.starred) return a.starred ? -1 : 1;
      return new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime();
    });

    return NextResponse.json({ conversations });
  } catch {
    return NextResponse.json({ conversations: [] });
  }
}
