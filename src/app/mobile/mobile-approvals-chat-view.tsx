'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { MobileMarkdown } from './mobile-markdown';
import { ttsEngine, type PlaybackState, type TTSEngineState } from '@/lib/tts/engine';
import { initSounds, playSendClick } from '@/lib/mobile/sounds';
import {
  DEFAULT_MOBILE_CHAT_MODEL,
  IconCaretDown,
  IconChat,
  IconSend,
  IconSpeaker,
  IconStop,
  MOBILE_CHAT_STORAGE_KEY,
  MobilePalette,
  generateChatTabId,
  getConversationTitle,
  mobileFontFamily,
  normalizeChatMessages,
  type ChatMessage,
  type ModelOption,
} from './mobile-approvals-shared';

function StreamingDot({ palette }: { palette: MobilePalette }) {
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setExpanded((value) => !value);
    }, 720);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <span
      aria-label="Assistant is responding"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        color: palette.subduedText,
        fontSize: 13,
      }}
    >
      <span
        style={{
          width: expanded ? 22 : 8,
          height: 8,
          borderRadius: 999,
          backgroundColor: palette.accent,
          transition: 'width 0.28s ease',
        }}
      />
      Thinking
    </span>
  );
}

function TtsButton({
  messageId,
  text,
  palette,
}: {
  messageId: string;
  text: string;
  palette: MobilePalette;
}) {
  const [playback, setPlayback] = useState<PlaybackState>('idle');
  const isPlaying = playback === 'loading' || playback === 'playing';

  useEffect(() => {
    initSounds();
    return ttsEngine.subscribe((state: TTSEngineState) => {
      const active = state.activeMessageId === messageId;
      setPlayback(active ? state.state : 'idle');
    });
  }, [messageId]);

  const glassPill: CSSProperties = {
    height: 28,
    borderRadius: 999,
    border: `1px solid ${palette.cardBorder}`,
    paddingLeft: 10,
    paddingRight: 10,
    fontSize: 12,
    fontWeight: 700,
    fontFamily: mobileFontFamily(),
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    cursor: 'pointer',
    marginTop: 8,
  };

  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      <button
        onClick={() => {
          if (!isPlaying) void ttsEngine.play(text, messageId);
        }}
        disabled={isPlaying}
        style={{
          ...glassPill,
          background: isPlaying ? palette.cardBackground : palette.panelElevated,
          color: isPlaying ? palette.subduedText : palette.rootText,
          opacity: isPlaying ? 0.4 : 1,
        }}
      >
        <IconSpeaker fill={palette.iconFill} />
        {playback === 'loading' ? 'Loading...' : 'Play'}
      </button>
      {isPlaying ? (
        <button
          onClick={() => ttsEngine.stop()}
          style={{
            ...glassPill,
            background: `linear-gradient(135deg, ${palette.dangerSoft} 0%, ${palette.panelBackground} 100%)`,
            color: palette.rootText,
          }}
        >
          <IconStop fill={palette.iconFill} />
          Stop
        </button>
      ) : null}
    </div>
  );
}

export function ChatView({
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
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [showScrollDown, setShowScrollDown] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const activeTabRef = useRef<string | null>(currentTabId);
  const streamAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    activeTabRef.current = currentTabId;
  }, [currentTabId]);

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

    activeTabRef.current = currentTabId;
    streamAbortRef.current?.abort();
    streamAbortRef.current = null;
    setStreaming(false);
    setInput('');
    setMessages([]);
    setHistoryLoading(true);

    let cancelled = false;

    void (async () => {
      try {
        const response = await fetch(`/api/v2/chat-history?tabId=${encodeURIComponent(currentTabId)}`, { cache: 'no-store' });
        if (!response.ok) throw new Error('Failed to load chat history');

        const data = await response.json() as { messages?: unknown };
        if (!cancelled) {
          setMessages(normalizeChatMessages(data.messages));
        }
      } catch {
        if (!cancelled) {
          setMessages([]);
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

  useEffect(() => () => {
    streamAbortRef.current?.abort();
  }, []);

  const saveConversation = useCallback(async (tabId: string, nextMessages: ChatMessage[]) => {
    if (!tabId || nextMessages.length === 0) return;

    try {
      await fetch('/api/v2/chat-history', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        keepalive: true,
        body: JSON.stringify({
          tabId,
          messages: nextMessages,
          model: selectedModel.id || DEFAULT_MOBILE_CHAT_MODEL,
          title: getConversationTitle(nextMessages),
        }),
      });
      onConversationSaved();
    } catch {
      // non-critical persistence failure
    }
  }, [onConversationSaved, selectedModel.id]);

  const sendMessage = useCallback(async () => {
    const text = input.trim();
    const tabId = currentTabId;
    if (!text || streaming || historyLoading || !tabId) return;

    setInput('');

    const userMessage: ChatMessage = { role: 'user', content: text };
    const assistantMessage: ChatMessage = { role: 'assistant', content: '' };
    const requestMessages = [...messages, userMessage];
    let finalMessages = [...requestMessages, assistantMessage];
    setMessages(finalMessages);
    setStreaming(true);

    const controller = new AbortController();
    streamAbortRef.current = controller;

    try {
      const response = await fetch('/api/v2/proxy/llm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          model: selectedModel.id,
          provider: selectedModel.provider,
          messages: requestMessages.map((message) => ({ role: message.role, content: message.content })),
          stream: true,
        }),
      });

      if (!response.ok || !response.body) {
        finalMessages = [...requestMessages, { role: 'assistant', content: 'Failed to get a response. Check your API keys.' }];
        if (activeTabRef.current === tabId) {
          setMessages(finalMessages);
        }
        await saveConversation(tabId, finalMessages);
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let fullText = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const payload = line.slice(6).trim();
          if (payload === '[DONE]') continue;

          try {
            const parsed = JSON.parse(payload) as { type?: string; text?: string };
            if (parsed.type === 'content' && parsed.text) {
              fullText += parsed.text;
              finalMessages = [...requestMessages, { role: 'assistant', content: fullText }];
              if (activeTabRef.current === tabId) {
                setMessages(finalMessages);
              }
            }
          } catch {
            // Skip malformed SSE lines.
          }
        }
      }

      if (!fullText.trim()) {
        finalMessages = [...requestMessages, { role: 'assistant', content: 'No response received.' }];
        if (activeTabRef.current === tabId) {
          setMessages(finalMessages);
        }
      }

      await saveConversation(tabId, finalMessages);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        const persistedMessages = finalMessages[finalMessages.length - 1]?.content.trim()
          ? finalMessages
          : requestMessages;

        if (activeTabRef.current === tabId) {
          setMessages(persistedMessages);
        }
        await saveConversation(tabId, persistedMessages);
        return;
      }

      finalMessages = [...requestMessages, { role: 'assistant', content: 'Connection error. Is the server running?' }];
      if (activeTabRef.current === tabId) {
        setMessages(finalMessages);
      }
      await saveConversation(tabId, finalMessages);
    } finally {
      if (streamAbortRef.current === controller) {
        streamAbortRef.current = null;
      }
      if (activeTabRef.current === tabId) {
        setStreaming(false);
      }
    }
  }, [currentTabId, historyLoading, input, messages, saveConversation, selectedModel.id, selectedModel.provider, streaming]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, position: 'relative' }}>
      <div
        ref={scrollRef}
        onScroll={() => {
          const element = scrollRef.current;
          if (!element) return;
          setShowScrollDown(element.scrollHeight - element.scrollTop - element.clientHeight > 150);
        }}
        style={{ flex: 1, overflowY: 'auto', paddingBottom: 16, paddingTop: 8 }}
      >
        {(historyLoading || !currentTabId) ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', paddingTop: 100, color: palette.subduedText }}>
            <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 4, color: palette.rootText }}>Loading conversation</div>
            <div style={{ fontSize: 13, textAlign: 'center', padding: '0 32px', lineHeight: 1.6 }}>
              Pulling saved messages from your chat history.
            </div>
          </div>
        ) : null}

        {!historyLoading && currentTabId && messages.length === 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', paddingTop: 100, color: palette.subduedText }}>
            <IconChat fill={palette.iconFill} style={{ opacity: 0.28 }} />
            <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 4, marginTop: 16, color: palette.rootText }}>
              Chat with {selectedModel.label}
            </div>
            <div style={{ fontSize: 13, textAlign: 'center', padding: '0 32px', lineHeight: 1.6 }}>
              Ask questions, brainstorm, or get help with your projects.
            </div>
          </div>
        ) : null}

        {messages.map((message, index) => (
          <div
            key={index}
            style={{
              marginBottom: message.role === 'user' ? 14 : 20,
              display: 'flex',
              justifyContent: message.role === 'user' ? 'flex-end' : 'flex-start',
            }}
          >
            {message.role === 'user' ? (
              <div
                style={{
                  maxWidth: '82%',
                  padding: '10px 14px',
                  borderRadius: 18,
                  borderBottomRightRadius: 8,
                  background: palette.userBubble,
                  color: palette.rootText,
                  border: `1px solid ${palette.cardBorder}`,
                  fontSize: 14,
                  lineHeight: 1.55,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                }}
              >
                {message.content}
              </div>
            ) : (
              <div style={{ width: '100%', paddingTop: 2, paddingRight: 18 }}>
                {message.content ? (
                  <>
                    <MobileMarkdown content={message.content} />
                    {!streaming ? (
                      <TtsButton messageId={`msg-${index}`} text={message.content} palette={palette} />
                    ) : null}
                  </>
                ) : (streaming && index === messages.length - 1 ? <StreamingDot palette={palette} /> : null)}
              </div>
            )}
          </div>
        ))}
      </div>

      {showScrollDown ? (
        <button
          onClick={() => scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })}
          style={{
            position: 'absolute',
            bottom: 84,
            right: 20,
            zIndex: 5,
            width: 36,
            height: 36,
            borderRadius: 18,
            border: `1px solid ${palette.cardBorder}`,
            background: palette.panelElevated,
            backdropFilter: 'blur(12px)',
            WebkitBackdropFilter: 'blur(12px)',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: palette.shadow,
          } as CSSProperties}
        >
          <IconCaretDown fill={palette.iconFill} />
        </button>
      ) : null}

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          paddingTop: 10,
          paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 4px)',
          paddingLeft: 4,
          paddingRight: 4,
          background: palette.composerBackground,
          backdropFilter: 'blur(24px) saturate(180%)',
          WebkitBackdropFilter: 'blur(24px) saturate(180%)',
        } as CSSProperties}
      >
        <div
          style={{
            flex: 1,
            minHeight: 40,
            borderRadius: 20,
            border: `1px solid ${palette.inputBorder}`,
            background: palette.inputBackground,
            boxShadow: palette.shadow,
            display: 'flex',
            alignItems: 'center',
            paddingLeft: 16,
            paddingRight: 12,
          }}
        >
          <input
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                playSendClick();
                void sendMessage();
              }
            }}
            placeholder={`Message ${selectedModel.label}...`}
            disabled={streaming || historyLoading || !currentTabId}
            style={{
              flex: 1,
              height: 40,
              border: 'none',
              backgroundColor: 'transparent',
              color: palette.rootText,
              fontSize: 16,
              outline: 'none',
              fontFamily: mobileFontFamily(),
              lineHeight: '40px',
            }}
          />
        </div>
        <button
          onClick={() => {
            if (streaming) {
              streamAbortRef.current?.abort();
              return;
            }
            playSendClick();
            void sendMessage();
          }}
          disabled={!streaming && (!input.trim() || historyLoading || !currentTabId)}
          style={{
            width: 36,
            height: 36,
            borderRadius: 18,
            border: 'none',
            backgroundColor: streaming
              ? palette.dangerSoft
              : (input.trim() && !historyLoading && currentTabId)
                ? palette.accent
                : palette.cardBackground,
            color: palette.rootText,
            cursor: (streaming || (input.trim() && !historyLoading && currentTabId)) ? 'pointer' : 'default',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
            opacity: (streaming || (input.trim() && !historyLoading && currentTabId)) ? 1 : 0.48,
            boxShadow: (input.trim() && !streaming && !historyLoading && currentTabId) ? palette.shadow : 'none',
          }}
          aria-label={streaming ? 'Stop' : 'Send'}
        >
          {streaming ? <IconStop fill={palette.iconFill} /> : <IconSend fill={palette.iconFill} />}
        </button>
      </div>
    </div>
  );
}
