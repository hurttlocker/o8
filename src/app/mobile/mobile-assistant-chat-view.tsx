'use client';

import { useEffect, useState } from 'react';
import { MobileAssistantChatThread } from './mobile-assistant-chat-thread';
import {
  MOBILE_CHAT_STORAGE_KEY,
  MOBILE_BODY_TRACKING,
  MOBILE_HEADING_TRACKING,
  MobilePalette,
  generateChatTabId,
  normalizeChatMessages,
  type ChatMessage,
  type ModelOption,
} from './mobile-approvals-shared';

export function AssistantChatView({
  currentTabId,
  onTabIdChange,
  onConversationSaved,
  selectedModel,
  palette,
}: {
  currentTabId: string | null;
  onTabIdChange: (tabId: string) => void;
  onConversationSaved: () => void;
  selectedModel: ModelOption;
  palette: MobilePalette;
}) {
  const [historyLoading, setHistoryLoading] = useState(false);
  const [initialMessages, setInitialMessages] = useState<ChatMessage[]>([]);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    if (currentTabId) {
      window.localStorage.setItem(MOBILE_CHAT_STORAGE_KEY, currentTabId);
      return;
    }

    const storedTabId = window.localStorage.getItem(MOBILE_CHAT_STORAGE_KEY);
    const nextTabId = storedTabId || generateChatTabId();
    window.localStorage.setItem(MOBILE_CHAT_STORAGE_KEY, nextTabId);
    onTabIdChange(nextTabId);
  }, [currentTabId, onTabIdChange]);

  useEffect(() => {
    if (!currentTabId) return;

    let cancelled = false;
    setHistoryLoading(true);
    setInitialMessages([]);

    void (async () => {
      try {
        const response = await fetch(`/api/v2/chat-history?tabId=${encodeURIComponent(currentTabId)}`, {
          cache: 'no-store',
        });
        if (!response.ok) throw new Error('Failed to load chat history');

        const data = await response.json() as { messages?: unknown };
        if (!cancelled) {
          setInitialMessages(normalizeChatMessages(data.messages));
        }
      } catch {
        if (!cancelled) {
          setInitialMessages([]);
        }
      } finally {
        if (!cancelled) {
          setHistoryLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [currentTabId]);

  if (historyLoading || !currentTabId) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, position: 'relative' }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', paddingTop: 100, color: palette.subduedText }}>
          <div style={{ fontSize: 15, fontWeight: 700, letterSpacing: MOBILE_HEADING_TRACKING, marginBottom: 4, color: palette.rootText }}>Loading conversation</div>
          <div style={{ fontSize: 13, textAlign: 'center', padding: '0 32px', lineHeight: 1.6, letterSpacing: MOBILE_BODY_TRACKING }}>
            Pulling saved messages from your chat history.
          </div>
        </div>
      </div>
    );
  }

  return (
    <MobileAssistantChatThread
      key={currentTabId}
      tabId={currentTabId}
      initialMessages={initialMessages}
      onConversationSaved={onConversationSaved}
      selectedModel={selectedModel}
      palette={palette}
    />
  );
}
