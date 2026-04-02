import { NextResponse } from 'next/server';
import { ensurePersistedMobileLlmChatSession, createMobileLlmTabId } from '@/lib/llm/mobile-chat-session';
import { invalidateInboxCache } from '@/lib/mobile/inbox';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST() {
  try {
    const tabId = createMobileLlmTabId();
    ensurePersistedMobileLlmChatSession(tabId);
    invalidateInboxCache();

    return NextResponse.json(
      {
        sessionKey: `llm-chat:${tabId}`,
        tabId,
      },
      {
        headers: {
          'Cache-Control': 'no-store, max-age=0',
        },
      },
    );
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Unable to create a mobile chat session',
      },
      { status: 500 },
    );
  }
}
