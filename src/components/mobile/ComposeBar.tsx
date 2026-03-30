'use client';

import Image from 'next/image';
import React, { memo } from 'react';
import { ArrowUp, FileDiff, Plus, Square, X } from 'lucide-react';
import type { ComposeBarProps } from './types';
import { ownedLifecycleLabel, ownedReviewDispositionLabel } from './utils';
import { autocompleteSlashCommand, getSlashCommandSuggestions, isSlashCommandText } from '@/lib/slash-commands';

function preserveMouseFocus(event: React.PointerEvent<HTMLButtonElement>) {
  if (event.pointerType === 'mouse') {
    event.preventDefault();
  }
}

export const ComposeBar = memo(function ComposeBar(props: ComposeBarProps) {
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

  const renderSlashSuggestions = () => (
    showSlashSuggestions ? (
      <div className="remodex-reference-slash-menu">
        {slashSuggestions.slice(0, 6).map((item) => (
          <button
            key={item.command}
            type="button"
            className="remodex-reference-slash-item"
            onClick={() => {
              handlers.onDraftChange(`${item.command} `);
              composeRef.current?.focus();
            }}
          >
            <span className="remodex-reference-slash-command">{item.command}</span>
            <span className="remodex-reference-slash-description">{item.description}</span>
          </button>
        ))}
      </div>
    ) : null
  );

  const renderComposerSurface = (placeholder: string) => (
    <>
      <textarea
        ref={composeRef}
        className="remodex-compose-input"
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
        placeholder={placeholder}
      />
      {renderSlashSuggestions()}
      <div className="remodex-compose-row remodex-reference-compose-row">
        <button type="button" className="remodex-reference-compose-mode">
          <span>&lt;/&gt;</span>
          <span>Code</span>
        </button>
        <div className="remodex-reference-compose-actions">
          <button
            type="button"
            className="remodex-reference-compose-plus"
            aria-label="Attach image"
            onClick={handlers.onAttach}
          >
            <Plus size={18} strokeWidth={2.2} />
          </button>
          <button
            type="button"
            className="remodex-reference-compose-primary"
            disabled={primaryDisabled}
            onPointerDown={preserveMouseFocus}
            onClick={handlePrimaryAction}
            aria-label={isStopState ? 'Stop run' : `Send message to ${session ? agentDisplayName(session) : 'Assistant'}`}
          >
            {isStopState ? <Square size={16} strokeWidth={2.5} /> : <ArrowUp size={18} strokeWidth={2.3} />}
          </button>
        </div>
      </div>
    </>
  );

  return (
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
                <strong>{attachment.fileName}</strong>
                <span>Attached to this turn</span>
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

      {isChatSession ? (
        <div className="remodex-compose-surface remodex-compose-surface-reference">
          {renderComposerSurface(attachments.length ? 'Add context for the image…' : 'Add feedback…')}
        </div>
      ) : canResumeOwnedCodex ? (
        <div className="remodex-compose-surface remodex-compose-surface-reference">
          {renderComposerSurface('Add feedback…')}
        </div>
      ) : (
        <div className="remodex-compose-surface remodex-compose-surface-watch">
          <div className="remodex-watch-card">
            <div className="remodex-watch-copy">
              <strong>{ownedQueuedTurn ? 'Turn queued' : 'Remote control is watching'}</strong>
              <p>
                {ownedQueuedTurn
                  ? 'The next turn is queued and will land once the current run settles.'
                  : `${ownedLifecycleLabel(ownedAvailability)} • ${ownedReviewDispositionLabel(ownedReviewDisposition)}`}
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
                onClick={handlers.onLoadCorrectionDraft}
                disabled={!sessionKey || !selectedReviewPacket}
              >
                <ArrowUp size={15} strokeWidth={2.1} />
                Draft reply
              </button>
            </div>
          </div>
        </div>
      )}

      {actionNote ? <p className="remodex-inline-action-note">{actionNote}</p> : null}
    </>
  );
});
