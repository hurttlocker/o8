'use client';

import { ComposerPrimitive, MessagePrimitive, useAuiState, type MessageState } from '@assistant-ui/react';
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { MobileMarkdown } from './mobile-markdown';
import { getMessageTextContent, getMessageThinkingBlocks, getMessageToolCalls } from './mobile-assistant-chat-runtime';
import { ttsEngine, type PlaybackState, type TTSEngineState } from '@/lib/tts/engine';
import { playSendClick } from '@/lib/mobile/sounds';
import {
  IconCaretDown,
  IconCaretRight,
  IconChat,
  IconSend,
  IconSpeaker,
  IconStop,
  MobilePalette,
  type MobileChatToolCall,
  mobileCardStyle,
  mobileFontFamily,
  type ModelOption,
} from './mobile-approvals-shared';
import { renderToolPart } from './mobile-tool-cards';

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

function ThinkingBlock({
  text,
  palette,
  isStreaming,
}: {
  text: string;
  palette: MobilePalette;
  isStreaming: boolean;
}) {
  const [collapsed, setCollapsed] = useState(!isStreaming);
  const isCollapsed = isStreaming ? false : collapsed;

  return (
    <div style={{ marginBottom: 10 }}>
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          setCollapsed((value) => !value);
        }}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
          padding: '6px 10px',
          borderRadius: 14,
          border: `1px solid ${palette.cardBorder}`,
          background: palette.cardBackground,
          color: palette.subduedText,
          cursor: 'pointer',
          fontFamily: mobileFontFamily(),
          fontSize: 12,
          fontWeight: 700,
        }}
      >
        {isCollapsed ? <IconCaretRight fill={palette.iconFill} size={14} /> : <IconCaretDown fill={palette.iconFill} size={14} />}
        <span style={{ fontStyle: 'italic' }}>Thinking</span>
        {isStreaming ? (
          <span style={{ color: palette.accent, fontWeight: 600 }}>Live</span>
        ) : null}
      </button>
      {!isCollapsed ? (
        <div
          style={{
            marginTop: 8,
            borderRadius: 16,
            border: `1px solid ${palette.cardBorder}`,
            background: palette.cardBackground,
            color: palette.mutedText,
            padding: '10px 12px',
            fontSize: 13,
            lineHeight: 1.65,
            fontStyle: 'italic',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {text}
        </div>
      ) : null}
    </div>
  );
}

/* ── Tool call card — delegates to specialized renderers in mobile-tool-cards ─ */

function ToolCallCard({
  toolCall,
  palette,
}: {
  toolCall: MobileChatToolCall;
  palette: MobilePalette;
}) {
  const light = palette.rootBackground !== '#111111';
  const status = toolCall.result?.status ?? toolCall.status ?? (toolCall.result ? 'done' : 'running');
  const isPending = status === 'calling' || status === 'running';
  const isError = status === 'error' || status === 'blocked' || toolCall.isError;

  return (
    <div style={{ marginBottom: 8 }}>
      {renderToolPart(toolCall.toolName, {
        toolCallId: toolCall.toolCallId,
        args: toolCall.arguments,
        result: toolCall.result?.output ?? toolCall.result,
        isError: isError || undefined,
        pending: isPending || undefined,
        light,
        palette,
      })}
    </div>
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
  };

  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          if (!isPlaying) {
            void ttsEngine.play(text, messageId);
          }
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
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            ttsEngine.stop();
          }}
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

export function ModelBadge({
  palette,
  selectedModel,
}: {
  palette: MobilePalette;
  selectedModel: ModelOption;
}) {
  const providerLabel = selectedModel.provider === 'google'
    ? 'Google'
    : selectedModel.provider === 'openai'
      ? 'OpenAI'
      : 'Anthropic';

  return (
    <div style={{ padding: '8px 4px 12px' }}>
      <div
        style={mobileCardStyle(palette, {
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
          padding: '9px 12px',
          borderRadius: 16,
          background: palette.panelElevated,
        })}
      >
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: 999,
            backgroundColor: palette.accent,
          }}
        />
        <span style={{ fontSize: 12, fontWeight: 700, color: palette.rootText }}>
          {selectedModel.label}
        </span>
        <span style={{ fontSize: 12, color: palette.subduedText }}>
          {providerLabel}
        </span>
      </div>
    </div>
  );
}

export function EmptyState({
  palette,
  selectedModel,
}: {
  palette: MobilePalette;
  selectedModel: ModelOption;
}) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '58%',
        color: palette.subduedText,
        paddingTop: 40,
      }}
    >
      <IconChat fill={palette.iconFill} style={{ opacity: 0.28 }} />
      <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 4, marginTop: 16, color: palette.rootText }}>
        Chat with {selectedModel.label}
      </div>
      <div style={{ fontSize: 13, textAlign: 'center', padding: '0 32px', lineHeight: 1.6 }}>
        Ask questions, brainstorm, or get help with your projects.
      </div>
    </div>
  );
}

// ── File Mention Suggestion Strip ──

interface FileSuggestion {
  path: string;
  name?: string;
}

function MentionStrip({
  suggestions,
  onSelect,
  palette,
}: {
  suggestions: FileSuggestion[];
  onSelect: (path: string) => void;
  palette: MobilePalette;
}) {
  if (suggestions.length === 0) return null;

  return (
    <div
      style={{
        display: 'flex',
        gap: 6,
        overflowX: 'auto',
        paddingTop: 6,
        paddingBottom: 6,
        paddingLeft: 4,
        paddingRight: 4,
        WebkitOverflowScrolling: 'touch',
        scrollbarWidth: 'none',
      } as CSSProperties}
    >
      {suggestions.map((file) => {
        const parts = file.path.split('/');
        const fileName = parts.pop() ?? file.path;
        const dirHint = parts.length > 0 ? `${parts.slice(-2).join('/')}/` : '';

        return (
          <button
            key={file.path}
            type="button"
            onClick={() => onSelect(file.path)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              paddingTop: 6,
              paddingBottom: 6,
              paddingLeft: 10,
              paddingRight: 10,
              borderRadius: 14,
              border: `1px solid ${palette.cardBorder}`,
              background: palette.cardBackground,
              cursor: 'pointer',
              flexShrink: 0,
              maxWidth: 200,
            }}
          >
            {dirHint ? (
              <span style={{
                fontSize: 11,
                fontFamily: 'SF Mono, Menlo, monospace',
                color: palette.subduedText,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}>
                {dirHint}
              </span>
            ) : null}
            <span style={{
              fontSize: 12,
              fontWeight: 600,
              fontFamily: 'SF Mono, Menlo, monospace',
              color: palette.rootText,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}>
              {fileName}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function ComposerBar({
  palette,
  selectedModel,
  repoPath,
}: {
  palette: MobilePalette;
  selectedModel: ModelOption;
  repoPath?: string | null;
}) {
  const isRunning = useAuiState((state) => state.thread.isRunning);
  const isLoading = useAuiState((state) => state.thread.isLoading);
  const isComposerEmpty = useAuiState((state) => state.thread.composer.isEmpty);

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [fileSuggestions, setFileSuggestions] = useState<FileSuggestion[]>([]);
  const searchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    const cursor = e.target.selectionStart ?? value.length;
    const textBefore = value.slice(0, cursor);
    const atMatch = textBefore.match(/@([\w./\-]*)$/);

    if (atMatch && atMatch[1].length >= 1 && repoPath) {
      const query = atMatch[1];
      if (searchTimeout.current) clearTimeout(searchTimeout.current);
      searchTimeout.current = setTimeout(async () => {
        try {
          const res = await fetch(`/api/v2/context/files?q=${encodeURIComponent(query)}`, {
            headers: { 'x-cortex-repo-path': repoPath },
            cache: 'no-store',
          });
          if (res.ok) {
            const data = await res.json() as { files?: FileSuggestion[] };
            setFileSuggestions(data.files ?? []);
          }
        } catch {
          setFileSuggestions([]);
        }
      }, 150);
    } else {
      setFileSuggestions([]);
      if (searchTimeout.current) clearTimeout(searchTimeout.current);
    }
  }, [repoPath]);

  const handleFileSelect = useCallback((filePath: string) => {
    const el = inputRef.current;
    if (!el) return;

    const value = el.value;
    const cursor = el.selectionStart ?? value.length;
    const textBefore = value.slice(0, cursor);
    const atMatch = textBefore.match(/@([\w./\-]*)$/);

    if (atMatch) {
      const start = cursor - atMatch[0].length;
      const newValue = value.slice(0, start) + `@${filePath} ` + value.slice(cursor);

      // Update the textarea via native setter to work with ComposerPrimitive
      const nativeSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      if (nativeSetter) {
        nativeSetter.call(el, newValue);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }

      setFileSuggestions([]);
      el.focus();
    }
  }, []);

  return (
    <div>
      <MentionStrip suggestions={fileSuggestions} onSelect={handleFileSelect} palette={palette} />
      <ComposerPrimitive.Root
        onSubmit={() => {
          if (!isRunning && !isComposerEmpty) {
            playSendClick();
          }
          setFileSuggestions([]);
        }}
        style={{
          display: 'flex',
          alignItems: 'flex-end',
          gap: 10,
          paddingTop: fileSuggestions.length > 0 ? 0 : 10,
          paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 8px)',
          paddingLeft: 4,
          paddingRight: 4,
        }}
      >
        <div
          style={{
            flex: 1,
            minHeight: 36,
            borderRadius: 18,
            border: `1px solid ${palette.inputBorder}`,
            background: palette.inputBackground,
            display: 'flex',
            alignItems: 'center',
            paddingLeft: 16,
            paddingRight: 12,
            paddingTop: 6,
            paddingBottom: 6,
          }}
        >
          <ComposerPrimitive.Input
            ref={inputRef}
            placeholder={`Message ${selectedModel.label}...`}
            submitMode="enter"
            minRows={1}
            maxRows={5}
            disabled={isLoading}
            onChange={handleInputChange}
            style={{
              flex: 1,
              border: 'none',
              backgroundColor: 'transparent',
              color: palette.rootText,
              fontSize: 16,
              outline: 'none',
              fontFamily: mobileFontFamily(),
              lineHeight: 1.45,
              resize: 'none',
              padding: 0,
            }}
          />
        </div>
        {isRunning ? (
          <ComposerPrimitive.Cancel
            style={{
              width: 36,
              height: 36,
              borderRadius: 18,
              border: 'none',
              backgroundColor: palette.dangerSoft,
              color: palette.rootText,
              cursor: 'pointer',
              flexShrink: 0,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <IconStop fill={palette.iconFill} size={16} />
          </ComposerPrimitive.Cancel>
        ) : (
          <button
            type="submit"
            disabled={isComposerEmpty || isLoading}
            style={{
              width: 36,
              height: 36,
              borderRadius: 18,
              border: 'none',
              backgroundColor: !isComposerEmpty && !isLoading ? palette.accent : palette.cardBackground,
              color: palette.rootText,
              cursor: !isComposerEmpty && !isLoading ? 'pointer' : 'default',
              opacity: !isComposerEmpty && !isLoading ? 1 : 0.58,
              flexShrink: 0,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <IconSend fill={palette.iconFill} />
          </button>
        )}
      </ComposerPrimitive.Root>
    </div>
  );
}

export function ChatMessageRow({
  message,
  palette,
  isThreadRunning,
  activeMessageId,
  onToggleActions,
  copiedMessageId,
  onCopy,
}: {
  message: MessageState;
  palette: MobilePalette;
  isThreadRunning: boolean;
  activeMessageId: string | null;
  onToggleActions: (messageId: string | null) => void;
  copiedMessageId: string | null;
  onCopy: (messageId: string, content: string) => void;
}) {
  const textContent = getMessageTextContent(message.content);
  const thinkingBlocks = message.role === 'assistant' ? getMessageThinkingBlocks(message.content) : [];
  const toolCalls = message.role === 'assistant' ? getMessageToolCalls(message.content) : [];
  const isAssistantStreaming = message.role === 'assistant' && message.status.type === 'running';
  const hideCancelledPlaceholder = message.role === 'assistant'
    && message.status.type === 'incomplete'
    && message.status.reason === 'cancelled'
    && !textContent.trim()
    && thinkingBlocks.length === 0
    && toolCalls.length === 0;

  if (hideCancelledPlaceholder) {
    return null;
  }

  const canRevealActions = !isThreadRunning && textContent.trim().length > 0;
  const showActions = activeMessageId === message.id && canRevealActions;
  const isCopied = copiedMessageId === message.id;

  return (
    <MessagePrimitive.Root
      onClick={() => {
        if (!canRevealActions) return;
        onToggleActions(activeMessageId === message.id ? null : message.id);
      }}
      style={{
        marginBottom: message.role === 'user' ? 14 : 20,
        display: 'flex',
        flexDirection: 'column',
        alignItems: message.role === 'user' ? 'flex-end' : 'flex-start',
        cursor: canRevealActions ? 'pointer' : 'default',
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
          {textContent}
        </div>
      ) : (
        <div style={{ width: '100%', paddingTop: 2, paddingRight: 18 }}>
          {thinkingBlocks.map((block, index) => (
            <ThinkingBlock
              key={`${message.id}-thinking-${index}`}
              text={block}
              palette={palette}
              isStreaming={isAssistantStreaming}
            />
          ))}
          {toolCalls.map((toolCall) => (
            <ToolCallCard key={toolCall.toolCallId} toolCall={toolCall} palette={palette} />
          ))}
          {textContent ? (
            <MobileMarkdown content={textContent} textColor={palette.rootText} light={palette.rootBackground !== '#111111'} />
          ) : isAssistantStreaming && toolCalls.length === 0 ? (
            <StreamingDot palette={palette} />
          ) : null}
        </div>
      )}

      {showActions ? (
        <div
          style={{
            display: 'flex',
            gap: 6,
            marginTop: 6,
            alignSelf: message.role === 'user' ? 'flex-end' : 'flex-start',
            flexWrap: 'wrap',
          }}
        >
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onCopy(message.id, textContent);
            }}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              padding: '5px 12px',
              borderRadius: 14,
              border: `1px solid ${palette.cardBorder}`,
              background: isCopied ? palette.successSoft : palette.cardBackground,
              color: isCopied ? palette.success : palette.mutedText,
              fontSize: 12,
              fontWeight: 500,
              cursor: 'pointer',
              fontFamily: mobileFontFamily(),
            }}
          >
            {isCopied ? 'Copied' : 'Copy'}
          </button>
          {message.role === 'assistant' ? (
            <TtsButton messageId={message.id} text={textContent} palette={palette} />
          ) : null}
        </div>
      ) : null}
    </MessagePrimitive.Root>
  );
}
