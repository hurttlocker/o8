'use client';

/**
 * HistoryThreadRow — one row of the orchestrator history sidebar. Renders the
 * runtime icon, title (or inline rename input), message count, hover-reveal
 * action strip, and the optional plan card for the currently-selected thread.
 *
 * Parent owns all state (hover, rename draft, copy status); this component is
 * presentational + event-forwarding.
 */

import { memo, type RefObject } from 'react';
import { CollapsiblePlanCard } from '@/components/desktop/CollapsiblePlanCard';
import { HistoryRowActions } from '@/components/desktop/HistoryRowActions';
import { ClaudeIcon, CodexIcon, GeminiIcon, OpenCodeIcon as OpencodeIcon } from '@/components/desktop/repo-registry/shared';

interface HistoryThreadRowProps {
  tabId: string;
  title: string;
  messageCount?: number;
  runtime: 'claude-code' | 'codex' | 'gemini' | 'opencode' | null;
  planText?: string | null;
  pinned: boolean;
  isCurrent: boolean;
  isDeleting: boolean;
  isHovered: boolean;
  renameDraft: string | null;
  renameInputRef?: RefObject<HTMLInputElement | null>;
  exportStatus: 'idle' | 'copying' | 'copied' | 'error';
  onHoverChange: (hovered: boolean) => void;
  onSelect: () => void;
  onPinToggle: () => void;
  onRenameStart: () => void;
  onRenameDraftChange: (draft: string) => void;
  onRenameCommit: () => void;
  onRenameCancel: () => void;
  onExport: () => void;
  onDelete: () => void;
}

function MessageSquareIcon({ size = 12 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>;
}

function PinIndicatorIcon({ size = 10 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M12 17v5" />
      <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
    </svg>
  );
}

function HistoryThreadRowBase({
  tabId,
  title,
  messageCount,
  runtime,
  planText,
  pinned,
  isCurrent,
  isDeleting,
  isHovered,
  renameDraft,
  renameInputRef,
  exportStatus,
  onHoverChange,
  onSelect,
  onPinToggle,
  onRenameStart,
  onRenameDraftChange,
  onRenameCommit,
  onRenameCancel,
  onExport,
  onDelete,
}: HistoryThreadRowProps) {
  const isRenaming = renameDraft !== null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div
        data-thread-row={tabId}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 2,
          width: 'calc(100% - 8px)',
          marginLeft: 4,
          marginRight: 4,
          borderRadius: 14,
          background: isCurrent
            ? 'var(--t-accent-soft)'
            : isHovered
              ? 'var(--t-panel-hover)'
              : 'transparent',
          transition: 'background 100ms',
          opacity: isDeleting ? 0.4 : 1,
          position: 'relative',
        }}
        onMouseEnter={() => onHoverChange(true)}
        onMouseLeave={() => onHoverChange(false)}
      >
        <button
          type="button"
          onClick={() => { if (!isRenaming) onSelect(); }}
          disabled={isDeleting}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            flex: 1,
            minWidth: 0,
            minHeight: 44,
            paddingTop: 9,
            paddingRight: 4,
            paddingBottom: 9,
            paddingLeft: 12,
            borderWidth: 0,
            background: 'transparent',
            cursor: isDeleting ? 'default' : 'pointer',
            textAlign: 'left',
            fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 22,
              height: 22,
              borderRadius: 6,
              flexShrink: 0,
              background: runtime
                ? 'transparent'
                : isCurrent
                  ? 'var(--t-accent)'
                  : 'var(--t-bg-card)',
              color: isCurrent ? '#ffffff' : 'var(--t-text-muted)',
              transition: 'background 120ms cubic-bezier(0.22, 1, 0.36, 1), color 120ms cubic-bezier(0.22, 1, 0.36, 1)',
            }}
          >
            {runtime === 'claude-code' ? (
              <ClaudeIcon size={16} />
            ) : runtime === 'codex' ? (
              <CodexIcon size={16} />
            ) : runtime === 'gemini' ? (
              <GeminiIcon size={16} />
            ) : runtime === 'opencode' ? (
              <OpencodeIcon size={16} />
            ) : (
              <MessageSquareIcon size={12} />
            )}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            {isRenaming ? (
              <input
                ref={renameInputRef}
                type="text"
                value={renameDraft ?? ''}
                onChange={(event) => onRenameDraftChange(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    onRenameCommit();
                  } else if (event.key === 'Escape') {
                    event.preventDefault();
                    onRenameCancel();
                  }
                }}
                onBlur={() => onRenameCommit()}
                onClick={(event) => event.stopPropagation()}
                style={{
                  width: '100%',
                  borderWidth: 1,
                  borderStyle: 'solid',
                  borderColor: 'var(--t-accent-border)',
                  borderRadius: 6,
                  paddingTop: 2,
                  paddingRight: 6,
                  paddingBottom: 2,
                  paddingLeft: 6,
                  outline: 'none',
                  background: 'var(--t-input-bg)',
                  color: 'var(--t-text)',
                  fontSize: 11.5,
                  fontWeight: 500,
                  fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
                  letterSpacing: '-0.005em',
                  boxSizing: 'border-box',
                }}
              />
            ) : (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  overflow: 'hidden',
                }}
              >
                {pinned ? (
                  <span
                    aria-label="Pinned"
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      color: 'var(--t-accent)',
                      flexShrink: 0,
                    }}
                  >
                    <PinIndicatorIcon size={10} />
                  </span>
                ) : null}
                <div
                  style={{
                    fontSize: 11.5,
                    fontWeight: isCurrent ? 600 : 500,
                    color: 'var(--t-text)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    lineHeight: 1.3,
                    letterSpacing: '-0.005em',
                    flex: 1,
                    minWidth: 0,
                  }}
                >
                  {title}
                </div>
              </div>
            )}
            {!isRenaming && messageCount != null && messageCount > 0 ? (
              <div
                style={{
                  fontSize: 9.5,
                  color: 'var(--t-text-muted)',
                  marginTop: 2,
                  fontWeight: 500,
                }}
              >
                {messageCount} msg{messageCount !== 1 ? 's' : ''}
              </div>
            ) : !isRenaming && messageCount === 0 ? (
              <div
                style={{
                  fontSize: 9.5,
                  color: 'var(--t-text-faint)',
                  marginTop: 2,
                  fontWeight: 500,
                  fontFamily: "'iA Writer Mono', 'JetBrains Mono', 'SF Mono', Menlo, ui-monospace, monospace",
                }}
              >
                (empty)
              </div>
            ) : null}
          </div>
        </button>
        <HistoryRowActions
          visible={isHovered || isRenaming}
          pinned={pinned}
          isDeleting={isDeleting}
          exportStatus={exportStatus}
          onPin={onPinToggle}
          onRename={onRenameStart}
          onExport={onExport}
          onDelete={onDelete}
        />
      </div>
      {isCurrent && planText ? (
        <div
          style={{
            paddingTop: 0,
            paddingRight: 8,
            paddingBottom: 6,
            paddingLeft: 8,
          }}
        >
          <CollapsiblePlanCard text={planText} compact />
        </div>
      ) : null}
    </div>
  );
}

export const HistoryThreadRow = memo(HistoryThreadRowBase);
