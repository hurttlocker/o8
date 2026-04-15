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
  messageCount: number;
  model: string;
  savedAt: string;
  modifiedAt: string;
  starred: boolean;
  planText?: string | null;
  repoName?: string | null;
  repoPath?: string | null;
  repoBranch?: string | null;
  remoteUrl?: string | null;
}

export async function GET(request: NextRequest) {
  const searchQuery = request.nextUrl.searchParams.get('q')?.toLowerCase();
  const includeOrchestrator = request.nextUrl.searchParams.get('include') === 'orchestrator';

  try {
    const files = readdirSync(HISTORY_DIR).filter(f => f.endsWith('.json'));
    const conversations: ChatHistoryEntry[] = [];

    for (const file of files) {
      try {
        const filePath = join(HISTORY_DIR, file);
        const stat = statSync(filePath);
        const raw = readFileSync(filePath, 'utf-8');
        const data = JSON.parse(raw);

        if (!data.messages || data.messages.length === 0) continue;

        // Skip orchestrator threads unless explicitly requested
        const tabId = basename(file, '.json');
        if (!includeOrchestrator && tabId.startsWith('thoughts-')) continue;

        const messages = data.messages as { role: string; content: string }[];
        const firstUserMsg = messages.find(m => m.role === 'user');
        const lastMsg = messages[messages.length - 1];

        // Generate title from first user message
        const title = data.title || (firstUserMsg
          ? firstUserMsg.content.slice(0, 60).replace(/\n/g, ' ') + (firstUserMsg.content.length > 60 ? '...' : '')
          : 'Untitled conversation');

        // Preview from last message
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
          messageCount: messages.length,
          model: data.model || 'unknown',
          savedAt: data.savedAt || stat.mtime.toISOString(),
          modifiedAt: stat.mtime.toISOString(),
          starred: data.starred || false,
          planText: typeof data.planText === 'string' && data.planText.trim() ? data.planText : null,
          repoName: data.repoName || null,
          repoPath: data.repoPath || null,
          repoBranch: data.repoBranch || null,
          remoteUrl: data.remoteUrl || null,
        });
      } catch { /* skip bad files */ }
    }

    // Sort: starred first, then by date descending
    conversations.sort((a, b) => {
      if (a.starred !== b.starred) return a.starred ? -1 : 1;
      return new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime();
    });

    return NextResponse.json({ conversations });
  } catch {
    return NextResponse.json({ conversations: [] });
  }
}
