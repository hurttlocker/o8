'use client';

import Image from 'next/image';
import React, { memo } from 'react';
import {
  ArrowUp,
  Brain,
  Check,
  Eye,
  FileDiff,
  Plus,
  RefreshCw,
  Sparkles,
  Square,
  X,
} from 'lucide-react';
import type { CSSProperties } from 'react';
import type { ComposeBarProps } from './types';
import { ownedLifecycleLabel, ownedReviewDispositionLabel } from './utils';
import { autocompleteSlashCommand, getSlashCommandSuggestions, isSlashCommandText } from '@/lib/slash-commands';

export const ComposeBar = memo(function ComposeBar({
  session,
  sessionKey,
  draft,
  attachments,
  actionState,
  enhancing,
  preEnhanceDraft,
  isChatSession,
  canResumeOwnedCodex,
  canInterruptOwnedCodex,
  selectedReviewPacket,
  reviewFiles,
  ownedAvailability,
  ownedReviewDisposition,
  ownedQueuedTurn,
  surfaceRefreshing,
  actionNote,
  compactLine,
  agentDisplayName,
  composeRef,
  fileInputRef,
  handlers,
  onModelPillTap,
  streamingText = '',
  agentRunning = false,
}: ComposeBarProps) {
  const [xrayOpen, setXrayOpen] = React.useState(false);
  const xrayRef = React.useRef<HTMLDivElement>(null);

  const isThinking = agentRunning && !streamingText;
  const isStreaming = agentRunning && !!streamingText;
  const xrayWordCount = streamingText ? streamingText.split(/\s+/).filter(Boolean).length : 0;

  // Auto-scroll x-ray panel
  React.useEffect(() => {
    if (xrayOpen && xrayRef.current) {
      xrayRef.current.scrollTop = xrayRef.current.scrollHeight;
    }
  }, [xrayOpen, streamingText]);
  const slashSuggestions = getSlashCommandSuggestions(draft);
  const showSlashSuggestions = isSlashCommandText(draft) && slashSuggestions.length > 0;

  const sendButtonStyle = (disabled: boolean): CSSProperties => ({
    marginLeft: 'auto',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '0.32rem',
    minWidth: 42,
    minHeight: 42,
    padding: '0 0.82rem',
    borderRadius: 999,
    border: 'none',
    background: disabled ? '#d1d5db' : '#ef4444',
    color: disabled ? '#9ca3af' : '#ffffff',
    fontSize: '0.84rem',
    fontWeight: 700,
    boxShadow: disabled ? 'none' : '0 4px 14px rgba(239, 68, 68, 0.4)',
    cursor: disabled ? 'default' : 'pointer',
  });

  const chatSendDisabled = !sessionKey || actionState !== 'idle' || (!draft.trim() && attachments.length === 0);
  const ownedSendDisabled = !sessionKey || actionState !== 'idle' || !draft.trim();

  return (
    <>
      {isChatSession ? (
        <>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            className="remodex-file-input-hidden"
            onChange={(event) => {
              void handlers.onAttachFiles(event.target.files);
              event.currentTarget.value = '';
            }}
          />
          {attachments.length ? (
            <div className="remodex-attachment-strip">
              {attachments.map((attachment) => (
                <div key={attachment.id} className="remodex-attachment-pill">
                  <Image src={attachment.previewUrl} alt={attachment.fileName} width={72} height={72} unoptimized />
                  <div className="remodex-attachment-pill-copy">
                    <strong>{compactLine(attachment.fileName, attachment.fileName, 20)}</strong>
                    <span>Ready to send</span>
                  </div>
                  <button
                    type="button"
                    className="remodex-attachment-pill-remove"
                    aria-label={`Remove ${attachment.fileName}`}
                    onClick={() => handlers.onRemoveAttachment(attachment.id)}
                  >
                    <X size={14} strokeWidth={2.2} />
                  </button>
                </div>
              ))}
            </div>
          ) : null}
          <div className="remodex-compose-surface">
            <div className="remodex-compose-status-bar">
              <button type="button" className="remodex-compose-chip remodex-compose-pill" onClick={onModelPillTap} style={{ cursor: "pointer", border: "none", background: "inherit", font: "inherit", color: "inherit", padding: "inherit" }}>{session?.model ?? 'live'}</button>
              {/* Thinking X-ray pill */}
              <button
                type="button"
                onClick={() => { if (isThinking || isStreaming) setXrayOpen(v => !v); }}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 4,
                  padding: '3px 8px', borderRadius: 8,
                  border: (isThinking || isStreaming) ? '1px solid rgba(147,197,253,0.3)' : '1px solid transparent',
                  background: (isThinking || isStreaming) ? 'rgba(147,197,253,0.08)' : 'transparent',
                  cursor: (isThinking || isStreaming) ? 'pointer' : 'default',
                  fontSize: 11, fontWeight: 600, fontFamily: 'inherit',
                  color: (isThinking || isStreaming) ? '#3b82f6' : 'var(--t-text-muted, #8e8e93)',
                  transition: 'color 200ms ease, background 200ms ease, border-color 200ms ease',
                }}
              >
                <Brain size={12} style={{ animation: isThinking ? 'pulse 1.5s ease-in-out infinite' : 'none', opacity: (isThinking || isStreaming) ? 1 : 0.5 }} />
                {isThinking ? 'Thinking…' : isStreaming ? `${xrayWordCount} words` : (session?.status ?? 'idle')}
              </button>
            </div>

            {/* X-ray expanded panel */}
            {xrayOpen && (isThinking || isStreaming) && (
              <div style={{
                borderRadius: 10,
                background: 'rgba(15, 23, 42, 0.92)',
                border: '1px solid rgba(59,130,246,0.2)',
                boxShadow: '0 4px 16px rgba(0,0,0,0.2)',
                maxHeight: 160,
                display: 'flex', flexDirection: 'column',
                overflow: 'hidden',
                marginBottom: 6,
              }}>
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 5,
                  padding: '6px 10px',
                  borderBottom: '1px solid rgba(255,255,255,0.06)',
                  flexShrink: 0,
                }}>
                  <Brain size={10} color="#60a5fa" style={{ animation: isThinking ? 'pulse 1.5s ease-in-out infinite' : 'none' }} />
                  <span style={{ fontSize: 9, fontWeight: 700, color: '#60a5fa', letterSpacing: '0.03em', textTransform: 'uppercase' }}>Chain of Thought</span>
                  {isStreaming && <span style={{ fontSize: 9, color: '#94a3b8', marginLeft: 'auto', fontFamily: '"SF Mono", ui-monospace, monospace' }}>{xrayWordCount}w</span>}
                  <button type="button" onClick={() => setXrayOpen(false)} style={{
                    marginLeft: isStreaming ? 4 : 'auto',
                    width: 16, height: 16, borderRadius: 4,
                    border: 'none', background: 'rgba(255,255,255,0.06)',
                    color: '#64748b', cursor: 'pointer',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 9,
                  }}>✕</button>
                </div>
                <div ref={xrayRef} style={{
                  flex: 1, overflowY: 'auto', padding: '8px 10px',
                  fontSize: 11, lineHeight: 1.5, color: '#cbd5e1',
                  fontFamily: '"SF Mono", ui-monospace, monospace',
                  whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                }}>
                  {isThinking && !streamingText ? (
                    <span style={{ color: '#64748b' }}>Reasoning in progress…</span>
                  ) : streamingText || ''}
                </div>
              </div>
            )}

            <textarea
              ref={composeRef}
              className="remodex-compose-input"
              rows={1}
              value={draft}
              onChange={(event) => {
                handlers.onDraftChange(event.target.value);
                // Auto-grow without jitter: measure off-screen then apply once
                const el = event.target;
                // Set to 0 instead of 'auto' — avoids visible collapse frame
                el.style.height = '0';
                const next = Math.min(el.scrollHeight, 160);
                el.style.height = `${next}px`;
              }}
              onKeyDown={(event) => {
                // Up arrow: recall last message (placeholder for mobile)
                if (event.key === 'Tab' && showSlashSuggestions) {
                  event.preventDefault();
                  const nextValue = autocompleteSlashCommand(draft);
                  if (nextValue) {
                    handlers.onDraftChange(`${nextValue} `);
                  }
                  return;
                }
                if (event.key === 'Enter' && !event.shiftKey && sessionKey && draft.trim()) {
                  event.preventDefault();
                  void handlers.onSend();
                }
              }}
              onFocus={() => handlers.onFocusChange(true)}
              onBlur={() => handlers.onFocusChange(false)}
              placeholder={attachments.length ? 'Add context for the image…' : `Message ${session ? agentDisplayName(session) : 'Mister'}…`}
            />
            {showSlashSuggestions ? (
              <div
                style={{
                  marginTop: 8,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 2,
                  padding: '6px 0',
                  borderRadius: 14,
                  border: '1px solid rgba(255,255,255,0.3)',
                  background: 'rgba(255,255,255,0.75)',
                  backdropFilter: 'blur(40px) saturate(1.8)',
                  WebkitBackdropFilter: 'blur(40px) saturate(1.8)',
                  boxShadow: '0 8px 32px rgba(0,0,0,0.12), 0 2px 8px rgba(0,0,0,0.06)',
                }}
              >
                {slashSuggestions.slice(0, 6).map((item) => (
                  <button
                    key={item.command}
                    type="button"
                    onClick={() => {
                      handlers.onDraftChange(`${item.command} `);
                      composeRef.current?.focus();
                    }}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 12,
                      width: '100%',
                      minHeight: 44,
                      padding: '8px 14px',
                      borderRadius: 0,
                      border: 'none',
                      background: 'transparent',
                      color: '#0f172a',
                      cursor: 'pointer',
                      textAlign: 'left',
                    }}
                  >
                    <span style={{ fontSize: '0.82rem', fontWeight: 700, fontFamily: '"SF Mono", ui-monospace, monospace' }}>
                      {item.command}
                    </span>
                    <span style={{ fontSize: '0.76rem', color: '#64748b' }}>{item.description}</span>
                  </button>
                ))}
              </div>
            ) : null}
            <div className="remodex-compose-row">
              <button
                type="button"
                className="remodex-compose-chip remodex-compose-chip-icon"
                aria-label="Attach image"
                onClick={handlers.onAttach}
              >
                <Plus size={16} strokeWidth={2.2} />
              </button>
              <button
                type="button"
                className="remodex-compose-chip remodex-compose-chip-icon"
                aria-label="Refresh conversation"
                onClick={() => {
                  void handlers.onRefresh();
                }}
              >
                <RefreshCw size={16} strokeWidth={2.2} className={surfaceRefreshing ? 'spin' : undefined} />
              </button>
              {/* Brain/recall button removed — memory accessible via hamburger menu */}
              {draft.trim().length >= 3 ? (
                preEnhanceDraft !== null ? (
                  <button
                    type="button"
                    className="remodex-compose-chip remodex-compose-chip-icon"
                    aria-label="Undo enhancement"
                    onClick={handlers.onUndoEnhance}
                    style={{ color: '#ef4444', fontSize: 13, fontWeight: 600, minWidth: 42, minHeight: 42, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(239,68,68,0.08)', borderRadius: 999, border: 'none', cursor: 'pointer' }}
                  >
                    Undo
                  </button>
                ) : (
                  <button
                    type="button"
                    className="remodex-compose-chip remodex-compose-chip-icon"
                    aria-label="Enhance prompt"
                    disabled={enhancing}
                    onClick={() => void handlers.onEnhance()}
                    style={{ minWidth: 42, minHeight: 42, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: 'none', border: 'none', cursor: enhancing ? 'default' : 'pointer', color: enhancing ? '#d1d5db' : '#ff9f0a' }}
                  >
                    <Sparkles size={18} strokeWidth={2} className={enhancing ? 'spin' : undefined} />
                  </button>
                )
              ) : null}
              <button
                type="button"
                style={sendButtonStyle(chatSendDisabled)}
                disabled={chatSendDisabled}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  if (!sessionKey) {
                    return;
                  }
                  void handlers.onSend();
                }}
                aria-label={`Send message to ${session ? agentDisplayName(session) : 'Mister'}`}
              >
                {actionState === 'steering' ? (
                  <>
                    <RefreshCw size={17} className="spin" />
                    <span>Sending</span>
                  </>
                ) : (
                  <>
                    <ArrowUp size={17} strokeWidth={2.2} />
                    <span>Send</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </>
      ) : canResumeOwnedCodex ? (
        <div className="remodex-compose-surface remodex-compose-surface-watch">
          <div className="remodex-watch-card">
            <div className="remodex-watch-copy">
              <strong>Message Codex</strong>
              <p>Send the next turn between runs. Queues immediately — output lands once Codex starts.</p>
            </div>
            <textarea
              ref={composeRef}
              className="remodex-compose-input"
              rows={2}
              value={draft}
              onChange={(event) => handlers.onDraftChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Tab' && showSlashSuggestions) {
                  event.preventDefault();
                  const nextValue = autocompleteSlashCommand(draft);
                  if (nextValue) {
                    handlers.onDraftChange(`${nextValue} `);
                  }
                  return;
                }
                if (event.key === 'Enter' && !event.shiftKey && sessionKey && draft.trim()) {
                  event.preventDefault();
                  void handlers.onOwnedResume();
                }
              }}
              onFocus={() => handlers.onFocusChange(true)}
              onBlur={() => handlers.onFocusChange(false)}
              placeholder="Next instruction for Codex…"
            />
            {showSlashSuggestions ? (
              <div
                style={{
                  marginTop: 8,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 2,
                  padding: '6px 0',
                  borderRadius: 14,
                  border: '1px solid rgba(255,255,255,0.3)',
                  background: 'rgba(255,255,255,0.75)',
                  backdropFilter: 'blur(40px) saturate(1.8)',
                  WebkitBackdropFilter: 'blur(40px) saturate(1.8)',
                  boxShadow: '0 8px 32px rgba(0,0,0,0.12), 0 2px 8px rgba(0,0,0,0.06)',
                }}
              >
                {slashSuggestions.slice(0, 6).map((item) => (
                  <button
                    key={item.command}
                    type="button"
                    onClick={() => {
                      handlers.onDraftChange(`${item.command} `);
                      composeRef.current?.focus();
                    }}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 12,
                      width: '100%',
                      minHeight: 44,
                      padding: '8px 14px',
                      borderRadius: 0,
                      border: 'none',
                      background: 'transparent',
                      color: '#0f172a',
                      cursor: 'pointer',
                      textAlign: 'left',
                    }}
                  >
                    <span style={{ fontSize: '0.82rem', fontWeight: 700, fontFamily: '"SF Mono", ui-monospace, monospace' }}>
                      {item.command}
                    </span>
                    <span style={{ fontSize: '0.76rem', color: '#64748b' }}>{item.description}</span>
                  </button>
                ))}
              </div>
            ) : null}
            <div className="remodex-owned-quick-actions">
              <button
                type="button"
                className="remodex-compose-chip"
                onClick={handlers.onLoadCorrectionDraft}
                disabled={!sessionKey || !selectedReviewPacket}
              >
                <ArrowUp size={15} strokeWidth={2.1} />
                Draft reply
              </button>
              <button
                type="button"
                className="remodex-compose-chip"
                onClick={handlers.onOpenDiff}
                disabled={!reviewFiles.length}
              >
                <FileDiff size={15} strokeWidth={2.1} />
                Exact diff
              </button>
            </div>
            <div className="remodex-compose-row remodex-compose-row-watch remodex-compose-row-owned">
              <button
                type="button"
                className="remodex-compose-chip remodex-compose-chip-icon"
                aria-label="Refresh owned runtime surface"
                onClick={() => {
                  void handlers.onRefresh();
                }}
              >
                <RefreshCw size={16} strokeWidth={2.2} className={surfaceRefreshing ? 'spin' : undefined} />
              </button>
              <button type="button" className="remodex-compose-chip remodex-compose-pill" onClick={onModelPillTap} style={{ cursor: 'pointer', border: 'none', background: 'inherit', font: 'inherit', color: 'inherit', padding: 'inherit' }}>{session?.model ?? 'live'}</button>
              <button type="button" onClick={() => { if (isThinking || isStreaming) setXrayOpen(v => !v); }} className="remodex-compose-chip remodex-compose-pill" style={{ cursor: (isThinking || isStreaming) ? "pointer" : "default", border: (isThinking || isStreaming) ? "1px solid rgba(147,197,253,0.3)" : "none", background: "inherit", font: "inherit", color: (isThinking || isStreaming) ? "#3b82f6" : "inherit", padding: "inherit" }}>{isThinking ? "Thinking…" : isStreaming ? `${xrayWordCount}w` : ownedLifecycleLabel(ownedAvailability)}</button>
              <span className="remodex-compose-chip remodex-compose-pill">{ownedReviewDispositionLabel(ownedReviewDisposition)}</span>
              <button
                type="button"
                style={sendButtonStyle(ownedSendDisabled)}
                disabled={ownedSendDisabled}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  if (!sessionKey) {
                    return;
                  }
                  void handlers.onOwnedResume();
                }}
                aria-label="Send next turn to owned Codex"
              >
                {actionState === 'steering' ? (
                  <>
                    <RefreshCw size={17} className="spin" />
                    <span>Sending</span>
                  </>
                ) : (
                  <>
                    <ArrowUp size={17} strokeWidth={2.2} />
                    <span>Send</span>
                  </>
                )}
              </button>
            </div>
            <p className="remodex-compose-helper">Review diffs and send the next turn. Interrupt reappears while the run is active.</p>
          </div>
        </div>
      ) : (
        <div className="remodex-compose-surface remodex-compose-surface-watch">
          <div className="remodex-watch-card">
            <div className="remodex-watch-copy">
              <strong>{ownedQueuedTurn ? 'Turn queued' : canInterruptOwnedCodex ? 'Active run' : 'Review-first'}</strong>
              <p>
                {ownedQueuedTurn
                  ? 'Codex accepted the turn. This surface will promote into runtime watch once output starts landing.'
                  : canInterruptOwnedCodex
                    ? 'Interrupt is available while the run is active. Resume reappears once the run settles.'
                    : 'Review and diff context are live. Resume becomes available once the current run settles.'}
              </p>
            </div>
            <div className="remodex-owned-quick-actions">
              <button
                type="button"
                className="remodex-compose-chip"
                onClick={handlers.onOpenDiff}
                disabled={!reviewFiles.length}
              >
                <FileDiff size={15} strokeWidth={2.1} />
                Exact diff
              </button>
              <button
                type="button"
                className="remodex-compose-chip"
                onClick={() => {
                  void handlers.onToggleOwnedReviewDisposition();
                }}
                disabled={!sessionKey || !selectedReviewPacket || actionState !== 'idle'}
              >
                {ownedReviewDisposition === 'resolved' ? <Eye size={15} strokeWidth={2.1} /> : <Check size={15} strokeWidth={2.1} />}
                {ownedReviewDisposition === 'resolved' ? 'Keep watching' : 'Mark resolved'}
              </button>
              {canInterruptOwnedCodex ? (
                <button
                  type="button"
                  className="remodex-compose-chip remodex-compose-chip-danger"
                  onClick={() => {
                    void handlers.onInterrupt();
                  }}
                  disabled={!sessionKey || actionState !== 'idle'}
                >
                  <Square size={15} strokeWidth={2.1} />
                  Interrupt run
                </button>
              ) : null}
            </div>
            <div className="remodex-compose-row remodex-compose-row-watch">
              <button
                type="button"
                className="remodex-compose-chip remodex-compose-chip-icon"
                aria-label="Refresh runtime watch"
                onClick={() => {
                  void handlers.onRefresh();
                }}
              >
                <RefreshCw size={16} strokeWidth={2.2} className={surfaceRefreshing ? 'spin' : undefined} />
              </button>
              <button type="button" className="remodex-compose-chip remodex-compose-pill" onClick={onModelPillTap} style={{ cursor: 'pointer', border: 'none', background: 'inherit', font: 'inherit', color: 'inherit', padding: 'inherit' }}>{session?.model ?? 'live'}</button>
              <button type="button" onClick={() => { if (isThinking || isStreaming) setXrayOpen(v => !v); }} className="remodex-compose-chip remodex-compose-pill" style={{ cursor: (isThinking || isStreaming) ? "pointer" : "default", border: (isThinking || isStreaming) ? "1px solid rgba(147,197,253,0.3)" : "none", background: "inherit", font: "inherit", color: (isThinking || isStreaming) ? "#3b82f6" : "inherit", padding: "inherit" }}>{isThinking ? "Thinking…" : isStreaming ? `${xrayWordCount}w` : ownedLifecycleLabel(ownedAvailability)}</button>
              <span className="remodex-compose-chip remodex-compose-pill">{ownedReviewDispositionLabel(ownedReviewDisposition)}</span>
            </div>
          </div>
        </div>
      )}
      {actionNote ? <p className="remodex-inline-action-note">{actionNote}</p> : null}
    </>
  );
});
