'use client';

import { ComposerPrimitive, MessagePrimitive, useAuiState, type MessageState } from '@assistant-ui/react';
import { useEffect, useState, type CSSProperties } from 'react';
import { MobileMarkdown } from './mobile-markdown';
import { getMessageTextContent, getMessageThinkingBlocks } from './mobile-assistant-chat-runtime';
import { ttsEngine, type PlaybackState, type TTSEngineState } from '@/lib/tts/engine';
import { playSendClick } from '@/lib/mobile/sounds';
import {
  MOBILE_BODY_TRACKING,
  MOBILE_CARD_RADIUS,
  MOBILE_GLASS_BLUR,
  MOBILE_HEADING_TRACKING,
  MOBILE_TOUCH_TARGET,
  IconCaretDown,
  IconCaretRight,
  IconChat,
  IconCopy,
  IconSend,
  IconSpeaker,
  IconStop,
  MobilePalette,
  mobileCardStyle,
  mobileFontFamily,
  type ModelOption,
} from './mobile-approvals-shared';

function StreamingDot() {
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
        gap: 8,
        minHeight: 36,
        padding: '0 12px',
        borderRadius: 999,
        border: '1px solid rgba(147, 197, 253, 0.26)',
        background: 'rgba(147, 197, 253, 0.14)',
        color: '#dbeafe',
        fontSize: 13,
        fontStyle: 'italic',
        letterSpacing: MOBILE_BODY_TRACKING,
      }}
    >
      <span
        style={{
          width: expanded ? 22 : 8,
          height: 8,
          borderRadius: 999,
          backgroundColor: '#bfdbfe',
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
          minHeight: MOBILE_TOUCH_TARGET,
          padding: '0 14px',
          borderRadius: MOBILE_CARD_RADIUS,
          border: '1px solid rgba(147, 197, 253, 0.26)',
          background: 'rgba(147, 197, 253, 0.12)',
          color: '#dbeafe',
          cursor: 'pointer',
          fontFamily: mobileFontFamily(),
          fontSize: 12,
          fontWeight: 700,
          letterSpacing: MOBILE_BODY_TRACKING,
          backdropFilter: `blur(${MOBILE_GLASS_BLUR}px)`,
          WebkitBackdropFilter: `blur(${MOBILE_GLASS_BLUR}px)`,
        }}
      >
        {isCollapsed ? <IconCaretRight fill="#dbeafe" size={14} /> : <IconCaretDown fill="#dbeafe" size={14} />}
        <span style={{ fontStyle: 'italic' }}>Thinking</span>
        {isStreaming ? (
          <span style={{ color: '#bfdbfe', fontWeight: 600, fontStyle: 'italic' }}>Live</span>
        ) : null}
      </button>
      {!isCollapsed ? (
        <div
          style={{
            marginTop: 8,
            borderRadius: MOBILE_CARD_RADIUS,
            border: '1px solid rgba(147, 197, 253, 0.2)',
            background: 'rgba(20, 26, 39, 0.62)',
            color: palette.mutedText,
            padding: '10px 12px',
            fontSize: 13,
            lineHeight: 1.65,
            letterSpacing: MOBILE_BODY_TRACKING,
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
    minHeight: MOBILE_TOUCH_TARGET,
    borderRadius: MOBILE_CARD_RADIUS,
    border: `1px solid ${palette.cardBorder}`,
    paddingLeft: 10,
    paddingRight: 10,
    fontSize: 12,
    fontWeight: 700,
    letterSpacing: MOBILE_BODY_TRACKING,
    fontFamily: mobileFontFamily(),
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    cursor: 'pointer',
    backdropFilter: `blur(${MOBILE_GLASS_BLUR}px)`,
    WebkitBackdropFilter: `blur(${MOBILE_GLASS_BLUR}px)`,
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
          background: isPlaying ? palette.cardBackground : palette.panelBackground,
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
            background: palette.dangerSoft,
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
  return (
    <div style={{ padding: '8px 4px 12px' }}>
      <div
        style={mobileCardStyle(palette, {
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
          padding: '9px 12px',
          borderRadius: MOBILE_CARD_RADIUS,
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
        <span style={{ fontSize: 12, fontWeight: 700, color: palette.rootText, letterSpacing: MOBILE_BODY_TRACKING }}>
          {selectedModel.label}
        </span>
        <span style={{ fontSize: 12, color: palette.subduedText, letterSpacing: MOBILE_BODY_TRACKING }}>
          o8 tuned
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
      <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 4, marginTop: 16, color: palette.rootText, letterSpacing: MOBILE_HEADING_TRACKING }}>
        Start an o8 chat
      </div>
      <div style={{ fontSize: 13, textAlign: 'center', padding: '0 32px', lineHeight: 1.6, letterSpacing: MOBILE_BODY_TRACKING }}>
        Ask questions, brainstorm, or get help with your projects from the branded mobile shell.
      </div>
      <div style={{ fontSize: 12, textAlign: 'center', padding: '0 32px', lineHeight: 1.6, letterSpacing: MOBILE_BODY_TRACKING, color: palette.subduedText, marginTop: 8 }}>
        Active model: {selectedModel.label}
      </div>
    </div>
  );
}

export function ComposerBar({
  palette,
  selectedModel,
}: {
  palette: MobilePalette;
  selectedModel: ModelOption;
}) {
  const isRunning = useAuiState((state) => state.thread.isRunning);
  const isLoading = useAuiState((state) => state.thread.isLoading);
  const isComposerEmpty = useAuiState((state) => state.thread.composer.isEmpty);

  return (
    <ComposerPrimitive.Root
      onSubmit={() => {
        if (!isRunning && !isComposerEmpty) {
          playSendClick();
        }
      }}
      style={{
        display: 'flex',
        alignItems: 'flex-end',
        gap: 10,
        paddingTop: 10,
        paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 8px)',
        paddingLeft: 4,
        paddingRight: 4,
        background: palette.composerBackground,
        backdropFilter: `blur(${MOBILE_GLASS_BLUR}px)`,
        WebkitBackdropFilter: `blur(${MOBILE_GLASS_BLUR}px)`,
      }}
    >
      <div
        style={{
          flex: 1,
          minHeight: MOBILE_TOUCH_TARGET,
          borderRadius: MOBILE_CARD_RADIUS,
          border: `1px solid ${palette.inputBorder}`,
          background: palette.inputBackground,
          boxShadow: palette.shadow,
          display: 'flex',
          alignItems: 'center',
          paddingLeft: 16,
          paddingRight: 12,
          paddingTop: 6,
          paddingBottom: 6,
        }}
      >
        <ComposerPrimitive.Input
          placeholder={`Message ${selectedModel.label}...`}
          submitMode="enter"
          minRows={1}
          maxRows={5}
          disabled={isLoading}
          style={{
            flex: 1,
            border: 'none',
            backgroundColor: 'transparent',
            color: palette.rootText,
            fontSize: 16,
            letterSpacing: MOBILE_BODY_TRACKING,
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
            width: MOBILE_TOUCH_TARGET,
            height: MOBILE_TOUCH_TARGET,
            borderRadius: MOBILE_CARD_RADIUS,
            border: `1px solid ${palette.dangerBorder}`,
            backgroundColor: palette.dangerSoft,
            color: palette.rootText,
            cursor: 'pointer',
            flexShrink: 0,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            backdropFilter: `blur(${MOBILE_GLASS_BLUR}px)`,
            WebkitBackdropFilter: `blur(${MOBILE_GLASS_BLUR}px)`,
          }}
        >
          <IconStop fill={palette.iconFill} size={16} />
        </ComposerPrimitive.Cancel>
      ) : (
        <button
          type="submit"
          disabled={isComposerEmpty || isLoading}
          style={{
            width: MOBILE_TOUCH_TARGET,
            height: MOBILE_TOUCH_TARGET,
            borderRadius: MOBILE_CARD_RADIUS,
            border: `1px solid ${!isComposerEmpty && !isLoading ? palette.accentBorder : palette.cardBorder}`,
            backgroundColor: !isComposerEmpty && !isLoading ? palette.accent : palette.panelBackground,
            color: palette.rootText,
            cursor: !isComposerEmpty && !isLoading ? 'pointer' : 'default',
            opacity: !isComposerEmpty && !isLoading ? 1 : 0.58,
            flexShrink: 0,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            backdropFilter: `blur(${MOBILE_GLASS_BLUR}px)`,
            WebkitBackdropFilter: `blur(${MOBILE_GLASS_BLUR}px)`,
          }}
        >
          <IconSend fill={!isComposerEmpty && !isLoading ? '#ffffff' : palette.iconFill} />
        </button>
      )}
    </ComposerPrimitive.Root>
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
  const isAssistantStreaming = message.role === 'assistant' && message.status.type === 'running';
  const hideCancelledPlaceholder = message.role === 'assistant'
    && message.status.type === 'incomplete'
    && message.status.reason === 'cancelled'
    && !textContent.trim()
    && thinkingBlocks.length === 0;

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
            borderRadius: MOBILE_CARD_RADIUS,
            background: palette.userBubble,
            color: palette.rootText,
            border: `1px solid ${palette.cardBorder}`,
            fontSize: 14,
            lineHeight: 1.55,
            letterSpacing: MOBILE_BODY_TRACKING,
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
          {textContent ? (
            <div
              style={mobileCardStyle(palette, {
                padding: '14px 16px',
                background: palette.panelBackground,
              })}
            >
              <MobileMarkdown content={textContent} />
            </div>
          ) : isAssistantStreaming ? (
            <StreamingDot />
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
              minHeight: MOBILE_TOUCH_TARGET,
              padding: '0 14px',
              borderRadius: MOBILE_CARD_RADIUS,
              border: `1px solid ${palette.cardBorder}`,
              background: isCopied ? palette.successSoft : palette.cardBackground,
              color: isCopied ? palette.success : palette.mutedText,
              fontSize: 12,
              fontWeight: 500,
              letterSpacing: MOBILE_BODY_TRACKING,
              cursor: 'pointer',
              fontFamily: mobileFontFamily(),
              backdropFilter: `blur(${MOBILE_GLASS_BLUR}px)`,
              WebkitBackdropFilter: `blur(${MOBILE_GLASS_BLUR}px)`,
            }}
          >
            <IconCopy fill={isCopied ? palette.success : palette.mutedText} size={14} />
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
