'use client';

import Image from 'next/image';
import { memo, type CSSProperties, type PointerEvent, type ReactNode } from 'react';
import type { ComposeBarProps } from './types';
import { useTheme } from './ThemeContext';
import { ownedLifecycleLabel, ownedReviewDispositionLabel } from './utils';
import { autocompleteSlashCommand, getSlashCommandSuggestions, isSlashCommandText } from '@/lib/slash-commands';

const SYSTEM_FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", system-ui, sans-serif';
const MONO_FONT = '"SF Mono", "SFMono-Regular", ui-monospace, Menlo, monospace';

function preserveMouseFocus(event: PointerEvent<HTMLButtonElement>) {
  if (event.pointerType === 'mouse') {
    event.preventDefault();
  }
}

function IconFrame({
  children,
  size = 18,
  strokeWidth = 2,
}: {
  children: ReactNode;
  size?: number;
  strokeWidth?: number;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

function ArrowUpIcon({ size = 18, strokeWidth = 2.3 }: { size?: number; strokeWidth?: number }) {
  return (
    <IconFrame size={size} strokeWidth={strokeWidth}>
      <path d="M12 19V5" />
      <path d="m6 11 6-6 6 6" />
    </IconFrame>
  );
}

function SquareIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <rect x="6.5" y="6.5" width="11" height="11" rx="2.5" />
    </svg>
  );
}

function FileDiffIcon({ size = 15, strokeWidth = 2.1 }: { size?: number; strokeWidth?: number }) {
  return (
    <IconFrame size={size} strokeWidth={strokeWidth}>
      <path d="M14 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7z" />
      <path d="M14 2v5h5" />
      <path d="M9 13h6" />
      <path d="M9 17h6" />
      <path d="M12 9h.01" />
    </IconFrame>
  );
}

function CloseIcon({ size = 14, strokeWidth = 2.2 }: { size?: number; strokeWidth?: number }) {
  return (
    <IconFrame size={size} strokeWidth={strokeWidth}>
      <path d="M18 6 6 18" />
      <path d="M6 6 18 18" />
    </IconFrame>
  );
}

export const ComposeBar = memo(function ComposeBar(props: ComposeBarProps) {
  const { colors, isDark } = useTheme();
  const {
    session,
    sessionKey,
    draft,
    attachments,
    actionState,
    isChatSession,
    canResumeOwnedCodex,
    selectedReviewPacket,
    reviewFiles,
    ownedAvailability,
    ownedReviewDisposition,
    ownedQueuedTurn,
    actionNote,
    agentDisplayName,
    composeRef,
    fileInputRef,
    handlers,
    agentRunning = false,
  } = props;

  void props.enhancing;
  void props.preEnhanceDraft;
  void props.canInterruptOwnedCodex;
  void props.surfaceRefreshing;
  void props.compactLine;
  void props.onOpenRecall;
  void props.onModelPillTap;
  void props.streamingText;

  const slashSuggestions = getSlashCommandSuggestions(draft);
  const showSlashSuggestions = isSlashCommandText(draft) && slashSuggestions.length > 0;
  const isStopState = agentRunning || actionState === 'stopping';
  const chatSendDisabled = !sessionKey || actionState !== 'idle' || (!draft.trim() && attachments.length === 0);
  const ownedSendDisabled = !sessionKey || actionState !== 'idle' || !draft.trim();
  const palette = {
    containerBg: isDark ? 'rgba(0,0,0,0.9)' : colors.frostBg,
    containerBorder: 'rgba(255,255,255,0.08)',
    surfaceBg: isDark ? 'rgba(28,28,30,0.82)' : colors.panelBg,
    surfaceBorder: 'rgba(255,255,255,0.08)',
    inputBg: isDark ? 'rgba(44,44,46,0.9)' : colors.msgAssistantBg,
    inputText: isDark ? '#F5F5F7' : colors.text,
    placeholderText: isDark ? '#636366' : colors.textTertiary,
    subtleText: isDark ? '#8E8E93' : colors.textSecondary,
    secondaryText: isDark ? '#98989D' : colors.textSecondary,
    primaryText: isDark ? '#F5F5F7' : colors.text,
    sendBg: isDark ? '#0A84FF' : colors.blueAccent,
    touchBg: isDark ? 'rgba(44,44,46,0.72)' : colors.blueSoft,
    chipBg: isDark ? 'rgba(44,44,46,0.72)' : colors.blueSoft,
    chipBorder: 'rgba(255,255,255,0.08)',
    removeBg: isDark ? 'rgba(58,58,60,0.96)' : colors.frostStrong,
    removeText: isDark ? '#8E8E93' : colors.textSecondary,
    shadow: isDark ? '0 10px 28px rgba(0,0,0,0.28)' : colors.shadow,
    sendShadow: isDark ? '0 10px 24px rgba(10,132,255,0.34)' : '0 10px 24px rgba(0,122,255,0.24)',
  };

  const handlePrimaryAction = () => {
    if (!sessionKey) {
      return;
    }
    if (isStopState) {
      void handlers.onStop();
      return;
    }
    if (isChatSession) {
      void handlers.onSend(sessionKey);
      return;
    }
    if (canResumeOwnedCodex) {
      void handlers.onOwnedResume(sessionKey);
    }
  };

  const primaryDisabled = isStopState ? !sessionKey || actionState === 'stopping' : (isChatSession ? chatSendDisabled : ownedSendDisabled);
  const containerStyle = {
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
    margin: '-10px',
    padding: '12px 10px calc(10px + env(safe-area-inset-bottom, 0px))',
    borderTop: `1px solid ${palette.containerBorder}`,
    borderRadius: 26,
    background: palette.containerBg,
    backdropFilter: 'blur(20px)',
    WebkitBackdropFilter: 'blur(20px)',
  } as CSSProperties;
  const surfaceStyle = {
    display: 'grid',
    gap: 12,
    padding: 12,
    borderRadius: 18,
    border: `1px solid ${palette.surfaceBorder}`,
    background: palette.surfaceBg,
    boxShadow: palette.shadow,
  } as CSSProperties;
  const inputShellStyle = {
    position: 'relative',
  } as CSSProperties;
  const textareaStyle: CSSProperties = {
    width: '100%',
    minHeight: 54,
    maxHeight: 160,
    padding: '14px 15px',
    border: `1px solid ${palette.surfaceBorder}`,
    borderRadius: 12,
    outline: 'none',
    resize: 'none',
    background: palette.inputBg,
    color: palette.inputText,
    fontFamily: SYSTEM_FONT,
    fontSize: 16,
    lineHeight: '22px',
    overflowY: 'auto',
    boxSizing: 'border-box',
    WebkitAppearance: 'none',
  };
  const placeholderStyle: CSSProperties = {
    position: 'absolute',
    top: 14,
    left: 15,
    right: 15,
    color: palette.placeholderText,
    fontFamily: SYSTEM_FONT,
    fontSize: 16,
    lineHeight: '22px',
    pointerEvents: 'none',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  };
  const quickActionStyle = {
    minWidth: 44,
    height: 44,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '0 14px',
    border: `1px solid ${palette.chipBorder}`,
    borderRadius: 12,
    background: palette.touchBg,
    color: palette.subtleText,
    fontFamily: SYSTEM_FONT,
    fontSize: 14,
    fontWeight: 600,
    letterSpacing: '-0.01em',
    cursor: 'pointer',
    WebkitTapHighlightColor: 'transparent',
  } as CSSProperties;
  const primaryButtonStyle = {
    width: 44,
    height: 44,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: 'none',
    borderRadius: '50%',
    background: palette.sendBg,
    color: '#FFFFFF',
    cursor: primaryDisabled ? 'default' : 'pointer',
    opacity: primaryDisabled ? 0.42 : 1,
    boxShadow: primaryDisabled ? 'none' : palette.sendShadow,
    WebkitTapHighlightColor: 'transparent',
  } as CSSProperties;
  const slashMenuStyle = {
    display: 'grid',
    gap: 4,
    padding: 6,
    borderRadius: 16,
    border: `1px solid ${palette.surfaceBorder}`,
    background: 'rgba(28,28,30,0.96)',
    boxShadow: '0 18px 34px rgba(0,0,0,0.26)',
  } as CSSProperties;
  const slashItemStyle = {
    width: '100%',
    minHeight: 44,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    padding: '0 12px',
    border: 'none',
    borderRadius: 12,
    background: 'transparent',
    color: palette.primaryText,
    textAlign: 'left',
    cursor: 'pointer',
    WebkitTapHighlightColor: 'transparent',
  } as CSSProperties;
  const attachmentStripStyle: CSSProperties = {
    display: 'flex',
    gap: 8,
    overflowX: 'auto',
    paddingBottom: 2,
    scrollbarWidth: 'none',
  };
  const attachmentPillStyle = {
    minWidth: 'min(100%, 240px)',
    display: 'grid',
    gridTemplateColumns: 'auto minmax(0, 1fr) auto',
    alignItems: 'center',
    gap: 10,
    padding: '10px 12px',
    borderRadius: 18,
    border: `1px solid ${palette.surfaceBorder}`,
    background: 'rgba(28,28,30,0.88)',
    boxShadow: palette.shadow,
  } as CSSProperties;
  const watchActionStyle = {
    ...quickActionStyle,
    gap: 6,
    background: palette.chipBg,
  } as CSSProperties;
  const actionNoteStyle: CSSProperties = {
    margin: 0,
    color: palette.subtleText,
    fontFamily: SYSTEM_FONT,
    fontSize: 13,
    lineHeight: '18px',
  };

  const handleCommandShortcut = () => {
    if (!draft.trim()) {
      handlers.onDraftChange('/');
    }
    composeRef.current?.focus();
  };

  const renderSlashSuggestions = () => (
    showSlashSuggestions ? (
      <div style={slashMenuStyle}>
        {slashSuggestions.slice(0, 6).map((item) => (
          <button
            key={item.command}
            type="button"
            style={slashItemStyle}
            onPointerDown={preserveMouseFocus}
            onClick={() => {
              handlers.onDraftChange(`${item.command} `);
              composeRef.current?.focus();
            }}
          >
            <span style={{
              color: palette.primaryText,
              fontFamily: MONO_FONT,
              fontSize: 13,
              fontWeight: 600,
            }}
            >
              {item.command}
            </span>
            <span style={{
              color: palette.secondaryText,
              fontFamily: SYSTEM_FONT,
              fontSize: 12,
            }}
            >
              {item.description}
            </span>
          </button>
        ))}
      </div>
    ) : null
  );

  const renderComposerSurface = (placeholder: string) => (
    <>
      <div style={inputShellStyle}>
        {!draft ? <span style={placeholderStyle}>{placeholder}</span> : null}
        <textarea
          ref={composeRef}
          rows={1}
          value={draft}
          onChange={(event) => {
            handlers.onDraftChange(event.target.value);
            const el = event.target;
            el.style.height = '0';
            const next = Math.min(el.scrollHeight, 160);
            el.style.height = `${next}px`;
          }}
          onKeyDown={(event) => {
            if (event.key === 'Tab' && showSlashSuggestions) {
              event.preventDefault();
              const nextValue = autocompleteSlashCommand(draft);
              if (nextValue) {
                handlers.onDraftChange(`${nextValue} `);
              }
              return;
            }
            if (event.key === 'Enter' && !event.shiftKey && sessionKey && draft.trim() && !isStopState) {
              event.preventDefault();
              if (isChatSession) {
                void handlers.onSend(sessionKey);
              } else if (canResumeOwnedCodex) {
                void handlers.onOwnedResume(sessionKey);
              }
            }
          }}
          onFocus={() => handlers.onFocusChange(true)}
          onBlur={() => handlers.onFocusChange(false)}
          aria-label={placeholder}
          style={textareaStyle}
        />
      </div>
      {renderSlashSuggestions()}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
      }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <button
            type="button"
            style={quickActionStyle}
            onPointerDown={preserveMouseFocus}
            aria-label="Attach file"
            onClick={handlers.onAttach}
          >
            @file
          </button>
          <button
            type="button"
            style={quickActionStyle}
            onPointerDown={preserveMouseFocus}
            aria-label="Insert slash command"
            onClick={handleCommandShortcut}
          >
            /cmds
          </button>
        </div>
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
          <button
            type="button"
            style={primaryButtonStyle}
            disabled={primaryDisabled}
            onPointerDown={preserveMouseFocus}
            onClick={handlePrimaryAction}
            aria-label={isStopState ? 'Stop run' : `Send message to ${session ? agentDisplayName(session) : 'Assistant'}`}
          >
            {isStopState ? <SquareIcon size={16} /> : <ArrowUpIcon size={18} strokeWidth={2.3} />}
          </button>
        </div>
      </div>
    </>
  );

  return (
    <div style={containerStyle}>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        style={{ display: 'none' }}
        onChange={(event) => {
          void handlers.onAttachFiles(event.target.files);
          event.currentTarget.value = '';
        }}
      />

      {attachments.length ? (
        <div style={attachmentStripStyle}>
          {attachments.map((attachment) => (
            <div key={attachment.id} style={attachmentPillStyle}>
              <Image
                src={attachment.previewUrl}
                alt={attachment.fileName}
                width={72}
                height={72}
                unoptimized
                style={{
                  width: 48,
                  height: 48,
                  borderRadius: 14,
                  objectFit: 'cover',
                  flexShrink: 0,
                }}
              />
              <div style={{ display: 'grid', gap: 2, minWidth: 0 }}>
                <strong style={{
                  display: 'block',
                  color: palette.primaryText,
                  fontFamily: SYSTEM_FONT,
                  fontSize: 15,
                  fontWeight: 600,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
                >
                  {attachment.fileName}
                </strong>
                <span style={{
                  color: palette.subtleText,
                  fontFamily: SYSTEM_FONT,
                  fontSize: 12,
                }}
                >
                  Attached to this turn
                </span>
              </div>
              <button
                type="button"
                style={{
                  width: 30,
                  height: 30,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  border: 'none',
                  borderRadius: '50%',
                  background: palette.removeBg,
                  color: palette.removeText,
                  cursor: 'pointer',
                  boxShadow: '0 6px 14px rgba(0,0,0,0.2)',
                  WebkitTapHighlightColor: 'transparent',
                }}
                aria-label={`Remove ${attachment.fileName}`}
                onPointerDown={preserveMouseFocus}
                onClick={() => handlers.onRemoveAttachment(attachment.id)}
              >
                <CloseIcon size={14} strokeWidth={2.2} />
              </button>
            </div>
          ))}
        </div>
      ) : null}

      {isChatSession ? (
        <div style={surfaceStyle}>
          {renderComposerSurface(attachments.length ? 'Add context for the image…' : 'Add feedback…')}
        </div>
      ) : canResumeOwnedCodex ? (
        <div style={surfaceStyle}>
          {renderComposerSurface('Add feedback…')}
        </div>
      ) : (
        <div style={surfaceStyle}>
          <div style={{ display: 'grid', gap: 12 }}>
            <div style={{ display: 'grid', gap: 4 }}>
              <strong style={{
                color: palette.primaryText,
                fontFamily: SYSTEM_FONT,
                fontSize: 15,
                fontWeight: 700,
              }}
              >
                {ownedQueuedTurn ? 'Turn queued' : 'Remote control is watching'}
              </strong>
              <p style={{
                margin: 0,
                color: palette.secondaryText,
                fontFamily: SYSTEM_FONT,
                fontSize: 13,
                lineHeight: '18px',
              }}
              >
                {ownedQueuedTurn
                  ? 'The next turn is queued and will land once the current run settles.'
                  : `${ownedLifecycleLabel(ownedAvailability)} • ${ownedReviewDispositionLabel(ownedReviewDisposition)}`}
              </p>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              <button
                type="button"
                style={watchActionStyle}
                onClick={handlers.onOpenDiff}
                onPointerDown={preserveMouseFocus}
                disabled={!reviewFiles.length}
              >
                <FileDiffIcon size={15} strokeWidth={2.1} />
                Exact diff
              </button>
              <button
                type="button"
                style={watchActionStyle}
                onClick={handlers.onLoadCorrectionDraft}
                onPointerDown={preserveMouseFocus}
                disabled={!sessionKey || !selectedReviewPacket}
              >
                <ArrowUpIcon size={15} strokeWidth={2.1} />
                Draft reply
              </button>
            </div>
          </div>
        </div>
      )}

      {actionNote ? <p style={actionNoteStyle}>{actionNote}</p> : null}
    </div>
  );
});
