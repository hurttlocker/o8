'use client';

import Image from 'next/image';
import { memo, type CSSProperties, type PointerEvent, type ReactNode } from 'react';
import type { ComposeBarProps } from './types';
import { useTheme } from './ThemeContext';
import { ownedLifecycleLabel, ownedReviewDispositionLabel } from './utils';
import { autocompleteSlashCommand, getSlashCommandSuggestions, isSlashCommandText } from '@/lib/slash-commands';
import { triggerHaptic } from '@/lib/mobile/haptic';

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
  const { colors } = useTheme();
  const {
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
    containerBg: colors.frostBg,
    containerBorder: colors.surfaceBorder,
    surfaceBg: colors.surface,
    surfaceBorder: colors.surfaceBorder,
    inputBg: colors.elevatedSurface,
    inputText: colors.text,
    placeholderText: colors.textTertiary,
    subtleText: colors.textSecondary,
    secondaryText: colors.textSecondary,
    primaryText: colors.text,
    sendBg: 'rgba(255,248,240,0.15)',
    touchBg: 'rgba(46,42,38,0.72)',
    chipBg: 'rgba(46,42,38,0.72)',
    chipBorder: colors.surfaceBorder,
    removeBg: 'rgba(62,56,50,0.96)',
    removeText: colors.textSecondary,
    shadow: '0 10px 28px rgba(0,0,0,0.28)',
    sendShadow: '0 10px 24px rgba(10,132,255,0.34)',
  };

  const handlePrimaryAction = () => {
    if (!sessionKey) {
      return;
    }
    if (isStopState) {
      triggerHaptic('warn');
      void handlers.onStop();
      return;
    }
    if (isChatSession) {
      triggerHaptic('success');
      void handlers.onSend(sessionKey);
      return;
    }
    if (canResumeOwnedCodex) {
      triggerHaptic('success');
      void handlers.onOwnedResume(sessionKey);
    }
  };

  const primaryDisabled = isStopState ? !sessionKey || actionState === 'stopping' : (isChatSession ? chatSendDisabled : ownedSendDisabled);
  const containerStyle = {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    padding: '8px 12px calc(8px + env(safe-area-inset-bottom, 0px))',
    background: 'transparent',
  } as CSSProperties;
  const surfaceStyle = {
    display: 'grid',
    gap: 12,
    padding: 0,
    background: 'transparent',
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
    color: '#FAF5F0',
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
    background: 'rgba(30,28,26,0.96)',
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
    background: 'rgba(30,28,26,0.88)',
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
      <div style={{
        display: 'flex',
        alignItems: 'flex-end',
        gap: 8,
      }}>
        <button
          type="button"
          onPointerDown={preserveMouseFocus}
          aria-label="Attach"
          onClick={handlers.onAttach}
          style={{
            width: 32,
            height: 32,
            minWidth: 32,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: 999,
            border: 'none',
            background: 'rgba(255,248,240,0.08)',
            color: '#A09890',
            cursor: 'pointer',
            padding: 0,
            flexShrink: 0,
            marginBottom: 2,
            WebkitTapHighlightColor: 'transparent',
          } as React.CSSProperties}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M5 12h14" /></svg>
        </button>
        <div style={{
          ...inputShellStyle,
          flex: 1,
          minHeight: 36,
          maxHeight: 160,
          padding: '6px 14px',
          borderRadius: 20,
        }}>
          {!draft ? <span style={{ ...placeholderStyle, top: 6, left: 14 }}>{placeholder}</span> : null}
          <textarea
            ref={composeRef}
            rows={1}
            value={draft}
            onChange={(event) => {
              handlers.onDraftChange(event.target.value);
              const el = event.target;
              el.style.height = '0';
              const next = Math.min(el.scrollHeight, 140);
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
            style={{
              ...textareaStyle,
              minHeight: 22,
              fontSize: 16,
              lineHeight: '22px',
            }}
          />
        </div>
        <button
          type="button"
          style={{
            ...primaryButtonStyle,
            width: 32,
            height: 32,
            minWidth: 32,
            minHeight: 32,
            marginBottom: 2,
          }}
          disabled={primaryDisabled}
          onPointerDown={preserveMouseFocus}
          onClick={handlePrimaryAction}
          aria-label={isStopState ? 'Stop run' : 'Send'}
        >
          {isStopState ? <SquareIcon size={14} /> : <ArrowUpIcon size={16} strokeWidth={2.5} />}
        </button>
      </div>
      {renderSlashSuggestions()}
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
