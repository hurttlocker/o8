'use client';

import Image from 'next/image';
import { memo } from 'react';
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
  onOpenRecall,
}: ComposeBarProps) {
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
              <span className="remodex-compose-chip remodex-compose-pill">{session?.model ?? 'live'}</span>
              <span className="remodex-compose-chip remodex-compose-pill remodex-compose-pill-status">{session?.status ?? 'idle'}</span>
            </div>
            <textarea
              ref={composeRef}
              className="remodex-compose-input"
              rows={2}
              value={draft}
              onChange={(event) => handlers.onDraftChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey && sessionKey && draft.trim()) {
                  event.preventDefault();
                  void handlers.onSend();
                }
              }}
              onFocus={() => handlers.onFocusChange(true)}
              onBlur={() => handlers.onFocusChange(false)}
              placeholder={attachments.length ? 'Add context for the image…' : `Message ${session ? agentDisplayName(session) : 'Mister'}…`}
            />
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
              {onOpenRecall ? (
                <button
                  type="button"
                  className="remodex-compose-chip remodex-compose-chip-icon"
                  aria-label="Memory recall"
                  onClick={onOpenRecall}
                  style={{ minWidth: 42, minHeight: 42, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: 'none', border: 'none', cursor: 'pointer', color: '#2563eb' }}
                >
                  <Brain size={17} strokeWidth={2} />
                </button>
              ) : null}
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
                if (event.key === 'Enter' && !event.shiftKey && sessionKey && draft.trim()) {
                  event.preventDefault();
                  void handlers.onOwnedResume();
                }
              }}
              onFocus={() => handlers.onFocusChange(true)}
              onBlur={() => handlers.onFocusChange(false)}
              placeholder="Next instruction for Codex…"
            />
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
              <span className="remodex-compose-chip remodex-compose-pill">{session?.model ?? 'live'}</span>
              <span className="remodex-compose-chip remodex-compose-pill remodex-compose-pill-status">{ownedLifecycleLabel(ownedAvailability)}</span>
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
              <span className="remodex-compose-chip remodex-compose-pill">{session?.model ?? 'live'}</span>
              <span className="remodex-compose-chip remodex-compose-pill remodex-compose-pill-status">{ownedLifecycleLabel(ownedAvailability)}</span>
              <span className="remodex-compose-chip remodex-compose-pill">{ownedReviewDispositionLabel(ownedReviewDisposition)}</span>
            </div>
          </div>
        </div>
      )}
      {actionNote ? <p className="remodex-inline-action-note">{actionNote}</p> : null}
    </>
  );
});
