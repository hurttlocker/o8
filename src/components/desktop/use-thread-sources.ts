'use client';

import { useEffect, useState } from 'react';
import { extractLinksFromText } from '@/lib/chat/sidebar-events';

export interface ThreadSource {
  label: string;
  href: string;
}

/**
 * Pull the operator's links out of a thread transcript: URLs from USER messages
 * only (never the agent's), deduped by href, in first-seen order. Pure so the
 * real extraction path is testable without a fetch.
 */
export function sourcesFromMessages(
  messages: Array<{ role?: string; content?: string }>,
): ThreadSource[] {
  const seen = new Set<string>();
  const out: ThreadSource[] = [];
  for (const message of messages) {
    if (message.role !== 'user' || typeof message.content !== 'string') continue;
    for (const link of extractLinksFromText(message.content)) {
      if (seen.has(link.href)) continue;
      seen.add(link.href);
      out.push(link);
    }
  }
  return out;
}

/**
 * The links the USER put into a thread's conversation — for the workspace rail's
 * Sources card. Reads the persisted transcript (GET /api/v2/chat-history) and
 * pulls URLs from USER messages only (never the agent's tool sources). Empty when
 * the thread has none. Populates on thread load / switch; a live in-session
 * refresh is a follow-up (persisted transcript is the source of truth here).
 */
export function useThreadSources(threadId: string | null | undefined): ThreadSource[] {
  const [sources, setSources] = useState<ThreadSource[]>([]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!threadId) {
        if (!cancelled) setSources([]);
        return;
      }
      try {
        const res = await fetch(`/api/v2/chat-history?tabId=${encodeURIComponent(threadId)}`, {
          credentials: 'same-origin',
        });
        if (!res.ok) {
          if (!cancelled) setSources([]);
          return;
        }
        const data = (await res.json()) as { messages?: Array<{ role?: string; content?: string }> };
        const messages = Array.isArray(data?.messages) ? data.messages : [];
        if (!cancelled) setSources(sourcesFromMessages(messages));
      } catch {
        if (!cancelled) setSources([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [threadId]);

  return sources;
}
