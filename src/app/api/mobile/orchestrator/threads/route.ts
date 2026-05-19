export const dynamic = 'force-dynamic';

/**
 * GET /api/mobile/orchestrator/threads — list recent orchestrator threads for
 * the mobile Orchestrator tab.
 *
 * Reads ~/.o8/chat-history/thoughts-*.json directly (same pattern as the
 * desktop OrchestratorHistorySidebar, which calls /api/v2/chat-history/list
 * with ?include=orchestrator). Projects each thread into a tiny mobile-shaped
 * payload — alpha is read-mostly, so we only need title, last activity,
 * runtime, status, and message count.
 *
 * Returns: { threads: MobileOrchestratorThread[] } — at most 20 most-recent.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import type { MobileOrchestratorThread } from '@/lib/mobile/types';

const HISTORY_DIR = join(homedir(), '.o8', 'chat-history');
const MAX_THREADS = 20;

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

export async function GET(request: NextRequest) {
  // ?backend=openclaw → only openclaw threads; otherwise → non-openclaw
  // threads (the default Orchestrator surface; untagged/legacy threads count
  // as non-openclaw). The two surfaces coexist — see docs/openclaw-integration.md.
  const wantOpenclaw = request.nextUrl.searchParams.get('backend') === 'openclaw';

  try {
    const files = readdirSync(HISTORY_DIR).filter((file) => file.endsWith('.json'));
    const threads: MobileOrchestratorThread[] = [];

    for (const file of files) {
      const tabId = basename(file, '.json');
      if (!tabId.startsWith('thoughts-')) continue;

      try {
        const filePath = join(HISTORY_DIR, file);
        const stat = statSync(filePath);
        const raw = readFileSync(filePath, 'utf-8');
        const data = JSON.parse(raw) as {
          title?: string;
          messages?: Array<{ role?: string; content?: string }>;
          model?: string;
          repoPath?: string | null;
          repoName?: string | null;
          repoBranch?: string | null;
          backend?: string;
          agent?: string;
        };

        const threadBackend: MobileOrchestratorThread['backend'] =
          data.backend === 'openclaw' || data.backend === 'codex' || data.backend === 'claude'
            ? data.backend
            : null;
        const threadAgent: MobileOrchestratorThread['agent'] =
          typeof data.agent === 'string' && data.agent.trim() ? data.agent : null;
        // Two surfaces: ?backend=openclaw gets only openclaw threads; the
        // default surface gets everything else (untagged/legacy included).
        if (wantOpenclaw ? threadBackend !== 'openclaw' : threadBackend === 'openclaw') {
          continue;
        }

        const messages = Array.isArray(data.messages) ? data.messages : [];
        const firstUserMessage = messages.find((message) => message.role === 'user');
        const lastMessage = messages[messages.length - 1];

        const fallbackTitle = firstUserMessage?.content
          ? firstUserMessage.content.slice(0, 60).replace(/\n/g, ' ') + (firstUserMessage.content.length > 60 ? '...' : '')
          : 'Untitled thread';

        const lastMessageAt = stat.mtime.toISOString();
        const isBusy = lastMessage?.role === 'user';

        threads.push({
          id: tabId,
          title: trimTitle(data.title, fallbackTitle),
          lastMessageAt,
          runtime: inferRuntime(data.model),
          status: messages.length === 0 ? 'idle' : isBusy ? 'busy' : 'ready',
          messageCount: messages.length,
          repoPath: typeof data.repoPath === 'string' ? data.repoPath : null,
          repoName: typeof data.repoName === 'string' ? data.repoName : null,
          repoBranch: typeof data.repoBranch === 'string' ? data.repoBranch : null,
          backend: threadBackend,
          agent: threadAgent,
        });
      } catch {
        // skip unreadable files
      }
    }

    threads.sort((left, right) => (
      new Date(right.lastMessageAt).getTime() - new Date(left.lastMessageAt).getTime()
    ));

    return NextResponse.json(
      { threads: threads.slice(0, MAX_THREADS) },
      { headers: { 'Cache-Control': 'no-store, max-age=0' } },
    );
  } catch (error) {
    console.log('[mobile-orchestrator] thread list failed', error);
    return NextResponse.json(
      { threads: [] },
      { headers: { 'Cache-Control': 'no-store, max-age=0' } },
    );
  }
}
