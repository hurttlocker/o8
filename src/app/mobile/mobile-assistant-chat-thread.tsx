'use client';

import { AssistantRuntimeProvider, ThreadPrimitive, useAuiState, useLocalRuntime, type ThreadMessage } from '@assistant-ui/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  createMobileChatModel,
  toAssistantUiMessages,
  toPersistedChatMessages,
  type PersistedMobileChatMessage,
} from './mobile-assistant-chat-runtime';
import { ChatMessageRow, ComposerBar, EmptyState, ModelBadge } from './mobile-assistant-chat-ui';
import { initSounds } from '@/lib/mobile/sounds';
import {
  DEFAULT_MOBILE_CHAT_MODEL,
  MOBILE_CARD_RADIUS,
  MOBILE_GLASS_BLUR,
  MOBILE_TOUCH_TARGET,
  IconCaretDown,
  MobilePalette,
  getConversationTitle,
  type ModelOption,
} from './mobile-approvals-shared';

function MobileAssistantThreadSurface({
  tabId,
  initialMessages,
  onConversationSaved,
  selectedModel,
  palette,
}: {
  tabId: string;
  initialMessages: PersistedMobileChatMessage[];
  onConversationSaved: () => void;
  selectedModel: ModelOption;
  palette: MobilePalette;
}) {
  const [activeMessageId, setActiveMessageId] = useState<string | null>(null);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const threadMessages = useAuiState((state) => state.thread.messages);
  const isThreadRunning = useAuiState((state) => state.thread.isRunning);
  const persistedMessages = useMemo(
    () => toPersistedChatMessages(threadMessages as readonly ThreadMessage[]),
    [threadMessages],
  );
  const persistSignature = useMemo(
    () => JSON.stringify({ model: selectedModel.id || DEFAULT_MOBILE_CHAT_MODEL, messages: persistedMessages }),
    [persistedMessages, selectedModel.id],
  );
  const visibleActiveMessageId = isThreadRunning ? null : activeMessageId;
  const lastSavedSignatureRef = useRef(
    JSON.stringify({ model: selectedModel.id || DEFAULT_MOBILE_CHAT_MODEL, messages: initialMessages }),
  );

  useEffect(() => {
    initSounds();
  }, []);

  const persistConversation = useCallback(async (messages: PersistedMobileChatMessage[], signature: string) => {
    if (!tabId || messages.length === 0) return;

    try {
      await fetch('/api/v2/chat-history', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        keepalive: true,
        body: JSON.stringify({
          tabId,
          messages,
          model: selectedModel.id || DEFAULT_MOBILE_CHAT_MODEL,
          title: getConversationTitle(messages),
        }),
      });
      lastSavedSignatureRef.current = signature;
      onConversationSaved();
    } catch {
      // Ignore persistence errors to keep the mobile thread responsive.
    }
  }, [onConversationSaved, selectedModel.id, tabId]);

  useEffect(() => {
    if (isThreadRunning || persistedMessages.length === 0) return;
    if (persistSignature === lastSavedSignatureRef.current) return;

    void persistConversation(persistedMessages, persistSignature);
  }, [isThreadRunning, persistConversation, persistSignature, persistedMessages]);

  return (
    <ThreadPrimitive.Root
      style={{
        display: 'flex',
        flexDirection: 'column',
        flex: 1,
        minHeight: 0,
        position: 'relative',
      }}
    >
      <ModelBadge palette={palette} selectedModel={selectedModel} />
      <ThreadPrimitive.Viewport
        autoScroll
        scrollToBottomOnRunStart
        scrollToBottomOnInitialize
        scrollToBottomOnThreadSwitch
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          paddingTop: 8,
          paddingBottom: 0,
        }}
      >
        <ThreadPrimitive.Empty>
          <EmptyState palette={palette} selectedModel={selectedModel} />
        </ThreadPrimitive.Empty>

        <ThreadPrimitive.Messages>
          {({ message }) => (
            <ChatMessageRow
              message={message}
              palette={palette}
              isThreadRunning={isThreadRunning}
              activeMessageId={visibleActiveMessageId}
              onToggleActions={setActiveMessageId}
              copiedMessageId={copiedMessageId}
              onCopy={(messageId, content) => {
                void navigator.clipboard.writeText(content).then(() => {
                  setCopiedMessageId(messageId);
                  window.setTimeout(() => {
                    setCopiedMessageId((current) => (current === messageId ? null : current));
                  }, 1800);
                }).catch(() => undefined);
              }}
            />
          )}
        </ThreadPrimitive.Messages>
      </ThreadPrimitive.Viewport>

      <div style={{ marginTop: 12 }}>
        <ComposerBar palette={palette} selectedModel={selectedModel} />
      </div>

      <ThreadPrimitive.ScrollToBottom
        behavior="smooth"
        style={{
          position: 'absolute',
          bottom: 'calc(env(safe-area-inset-bottom, 0px) + 84px)',
          right: 20,
          zIndex: 5,
          width: MOBILE_TOUCH_TARGET,
          height: MOBILE_TOUCH_TARGET,
          borderRadius: MOBILE_CARD_RADIUS,
          border: `1px solid ${palette.cardBorder}`,
          background: palette.panelElevated,
          backdropFilter: `blur(${MOBILE_GLASS_BLUR}px)`,
          WebkitBackdropFilter: `blur(${MOBILE_GLASS_BLUR}px)`,
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          boxShadow: palette.shadow,
        }}
      >
        <IconCaretDown fill={palette.iconFill} />
      </ThreadPrimitive.ScrollToBottom>
    </ThreadPrimitive.Root>
  );
}

export function MobileAssistantChatThread({
  tabId,
  initialMessages,
  onConversationSaved,
  selectedModel,
  palette,
}: {
  tabId: string;
  initialMessages: PersistedMobileChatMessage[];
  onConversationSaved: () => void;
  selectedModel: ModelOption;
  palette: MobilePalette;
}) {
  const chatModel = useMemo(
    () => createMobileChatModel(selectedModel),
    [selectedModel],
  );
  const runtime = useLocalRuntime(chatModel, {
    initialMessages: toAssistantUiMessages(initialMessages),
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <MobileAssistantThreadSurface
        tabId={tabId}
        initialMessages={initialMessages}
        onConversationSaved={onConversationSaved}
        selectedModel={selectedModel}
        palette={palette}
      />
    </AssistantRuntimeProvider>
  );
}
