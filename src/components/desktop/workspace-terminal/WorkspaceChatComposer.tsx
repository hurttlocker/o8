'use client';

import { memo } from 'react';
import {
  AlertCircle,
  Bookmark,
  MessageSquare,
  Plus,
  RotateCcw,
  Square,
  X,
} from '../lucide-shims';
import {
  THEME_ACCENT,
  THEME_ACCENT_BORDER,
  THEME_ACCENT_SOFT,
  THEME_BG_CARD,
} from '@/components/desktop/workspace-terminal/constants';
import type { TerminalTab } from '@/components/desktop/workspace-terminal/types';
import type { useWorkspaceChatPane } from '@/components/desktop/workspace-terminal/useWorkspaceChatPane';
import { WorkspaceCliModelPicker } from '@/components/desktop/workspace-terminal/WorkspaceCliModelPicker';

type ChatPaneState = ReturnType<typeof useWorkspaceChatPane>;

interface WorkspaceChatComposerProps {
  chat: ChatPaneState;
  tab: TerminalTab;
  isLaneArchived: boolean;
  onSaveCheckpoint: (tabId: string) => void;
  onRestoreLatestCheckpoint: (tabId: string) => void;
}

const PILL_FONT_FAMILY = "'iA Writer Mono', 'JetBrains Mono', 'SF Mono', Menlo, ui-monospace, monospace";

/**
 * Composer for Codex + Claude Code agent sessions. Mirrors the orchestrator
 * composer (ComposerArea + InputButtons + ContextMeter) aesthetic — hairline
 * 14px container over a solid paper surface, monospace footer pills for the
 * agent-session-specific actions (Link issue, Checkpoint, Restore latest), and
 * a ThinkingChip-style model/status pill that replaces the old green-dot
 * `GPT-5.4 ▾` bubble. Extracted out of WorkspaceChatPane to keep the pane
 * under the 800-line ceiling.
 */
function WorkspaceChatComposerBase({
  chat,
  tab,
  isLaneArchived,
  onSaveCheckpoint,
  onRestoreLatestCheckpoint,
}: WorkspaceChatComposerProps) {
  return (
    <div
      style={{
        paddingTop: 12,
        paddingBottom: 16,
        paddingLeft: 24,
        paddingRight: 24,
        borderTop: isLaneArchived ? 'none' : '1px solid var(--t-divider)',
        background: 'transparent',
        opacity: isLaneArchived ? 0.5 : 1,
        pointerEvents: isLaneArchived ? 'none' : 'auto',
      }}
    >
      <div
        style={{
          maxWidth: 720,
          marginLeft: 'auto',
          marginRight: 'auto',
          border: '1px solid var(--t-input-border)',
          borderRadius: 14,
          background: 'var(--t-input-bg)',
          overflow: 'hidden',
        }}
      >
        {chat.queuedContextCards.length > 0 ? (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              paddingTop: 14,
              paddingRight: 14,
              paddingBottom: 0,
              paddingLeft: 14,
              borderBottom: '1px solid var(--t-divider-subtle)',
            }}
          >
            {chat.queuedContextCards.map((card) => (
              <div
                key={card.id}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 10,
                  paddingTop: 8,
                  paddingBottom: 8,
                  paddingLeft: 10,
                  paddingRight: 10,
                  borderRadius: 12,
                  border: '1px solid var(--t-panel-border)',
                  background: THEME_BG_CARD,
                }}
              >
                <div
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: 28,
                    height: 28,
                    borderRadius: 9,
                    background: THEME_ACCENT_SOFT,
                    color: THEME_ACCENT,
                    flexShrink: 0,
                  }}
                >
                  <MessageSquare size={14} />
                </div>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: THEME_ACCENT }}>
                    Staged Context
                  </div>
                  <div style={{ marginTop: 3, fontSize: 12, fontWeight: 700, color: 'var(--t-text)' }}>
                    {card.title}
                  </div>
                  {card.meta.length > 0 ? (
                    <div style={{ marginTop: 3, display: 'flex', gap: 7, flexWrap: 'wrap', fontSize: 10, color: 'var(--t-text-muted)' }}>
                      {card.meta.slice(0, 2).map((entry) => (
                        <span key={entry}>{entry}</span>
                      ))}
                    </div>
                  ) : null}
                  {card.preview ? (
                    <div style={{ marginTop: 5, fontSize: 11, lineHeight: 1.45, color: 'var(--t-text-secondary)' }}>
                      {card.preview.length > 120 ? `${card.preview.slice(0, 117).trimEnd()}…` : card.preview}
                    </div>
                  ) : null}
                </div>
                <button
                  type="button"
                  onClick={() => chat.handleRemoveQueuedContext(card.id)}
                  title="Remove staged context"
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: 24,
                    height: 24,
                    borderRadius: 8,
                    borderWidth: 1,
                    borderStyle: 'solid',
                    borderColor: 'var(--t-border)',
                    background: 'transparent',
                    color: 'var(--t-text-muted)',
                    cursor: 'pointer',
                    flexShrink: 0,
                  }}
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        ) : null}

        <div style={{ paddingTop: 11, paddingBottom: 4, paddingLeft: 14, paddingRight: 14 }}>
          <textarea
            ref={chat.composeRef}
            name="workspaceComposeMessage"
            aria-label={`Message ${chat.runtimeLabel}`}
            value={chat.draft}
            onChange={(event) => {
              chat.setDraft(event.currentTarget.value);
              event.currentTarget.style.height = 'auto';
              event.currentTarget.style.height = `${Math.min(event.currentTarget.scrollHeight, 200)}px`;
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void chat.handleSend();
              }
            }}
            placeholder={chat.isAgentTab ? `Steer this ${chat.runtimeLabel} agent...` : `Message ${chat.runtimeLabel}...`}
            rows={2}
            style={{
              width: '100%',
              minHeight: 52,
              maxHeight: 200,
              border: 'none',
              outline: 'none',
              background: 'transparent',
              color: 'var(--t-text)',
              fontSize: 13,
              fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
              lineHeight: 1.4,
              resize: 'none',
              boxSizing: 'border-box',
              overflow: 'auto',
            }}
          />
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            paddingTop: 4,
            paddingBottom: 6,
            paddingLeft: 10,
            paddingRight: 8,
            flexWrap: 'wrap',
          }}
        >
          {/* Link issue — Rams-clean hairline pill */}
          <button
            type="button"
            onClick={() => chat.setIssuePickerOpen(true)}
            title={chat.linkedIssue ? `${chat.linkedIssue.title}` : 'Link a GitHub issue to this chat'}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              height: 26,
              paddingLeft: 8,
              paddingRight: 8,
              borderRadius: 8,
              borderWidth: 1,
              borderStyle: 'solid',
              borderColor: chat.linkedIssue ? THEME_ACCENT_BORDER : 'var(--t-border)',
              background: 'transparent',
              color: chat.linkedIssue ? THEME_ACCENT : 'var(--t-text-muted)',
              cursor: 'pointer',
              fontSize: 11.5,
              fontWeight: 400,
              letterSpacing: '0.01em',
              whiteSpace: 'nowrap',
              fontVariantNumeric: 'tabular-nums',
              fontFamily: PILL_FONT_FAMILY,
            }}
          >
            <AlertCircle size={12} />
            {chat.linkedIssue ? `issue #${chat.linkedIssue.number}` : 'link issue'}
          </button>

          {/* Checkpoint — Rams-clean hairline pill */}
          <button
            type="button"
            onClick={() => onSaveCheckpoint(chat.tabId)}
            disabled={chat.messages.length === 0}
            title={chat.messages.length === 0 ? 'Checkpoint becomes available once this chat has transcript history' : 'Save a safe checkpoint from this chat'}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              height: 26,
              paddingLeft: 8,
              paddingRight: 8,
              borderRadius: 8,
              borderWidth: 1,
              borderStyle: 'solid',
              borderColor: 'var(--t-border)',
              background: 'transparent',
              color: chat.messages.length === 0 ? 'var(--t-text-faint)' : 'var(--t-text-muted)',
              cursor: chat.messages.length === 0 ? 'default' : 'pointer',
              opacity: chat.messages.length === 0 ? 0.6 : 1,
              fontSize: 11.5,
              fontWeight: 400,
              letterSpacing: '0.01em',
              whiteSpace: 'nowrap',
              fontVariantNumeric: 'tabular-nums',
              fontFamily: PILL_FONT_FAMILY,
            }}
          >
            <Bookmark size={12} />
            checkpoint
          </button>

          {tab.chatCheckpoints && tab.chatCheckpoints.length > 0 ? (
            <button
              type="button"
              onClick={() => onRestoreLatestCheckpoint(chat.tabId)}
              title={`Restore from the latest checkpoint (${tab.chatCheckpoints[0]?.label})`}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                height: 26,
                paddingLeft: 8,
                paddingRight: 8,
                borderRadius: 8,
                borderWidth: 1,
                borderStyle: 'solid',
                borderColor: THEME_ACCENT_BORDER,
                background: 'transparent',
                color: THEME_ACCENT,
                cursor: 'pointer',
                fontSize: 11.5,
                fontWeight: 400,
                letterSpacing: '0.01em',
                whiteSpace: 'nowrap',
                fontVariantNumeric: 'tabular-nums',
                fontFamily: PILL_FONT_FAMILY,
              }}
            >
              <RotateCcw size={12} />
              restore latest
            </button>
          ) : null}

          <div style={{ flex: 1 }} />

          {/* Attach files placeholder */}
          <button
            type="button"
            disabled
            title="Attachments coming soon"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 24,
              height: 24,
              borderRadius: 7,
              borderWidth: 0,
              background: 'transparent',
              color: 'var(--t-text-faint)',
              cursor: 'default',
            }}
          >
            <Plus size={14} />
          </button>

          {/* Send / Stop */}
          {chat.agentRunning ? (
            <button
              type="button"
              disabled
              title="Agent is running"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 30,
                height: 30,
                borderRadius: 9,
                borderWidth: 0,
                background: '#ef4444',
                cursor: 'default',
                flexShrink: 0,
              }}
            >
              <Square size={13} style={{ color: '#ffffff' }} />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void chat.handleSend()}
              disabled={!chat.canSend || chat.sending}
              title="Send message (Enter)"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 30,
                height: 30,
                borderRadius: 9,
                borderWidth: 0,
                background: chat.canSend ? '#2563eb' : 'rgba(148, 163, 184, 0.18)',
                cursor: chat.canSend ? 'pointer' : 'default',
                transition: 'background 120ms',
                flexShrink: 0,
              }}
            >
              <svg width={14} height={14} viewBox="0 0 24 24" fill="none" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
                <path d="M12 19V5" stroke={chat.canSend ? '#ffffff' : '#9ca3af'} />
                <path d="m5 12 7-7 7 7" stroke={chat.canSend ? '#ffffff' : '#9ca3af'} />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Footer row — runtime · repo label on the left, model/status pill on the right */}
      <div
        style={{
          maxWidth: 720,
          marginLeft: 'auto',
          marginRight: 'auto',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 10,
          paddingTop: 6,
          paddingLeft: 2,
          paddingRight: 2,
          fontSize: 10,
          color: 'var(--t-text-faint)',
        }}
      >
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            minWidth: 0,
            fontSize: 10.5,
            fontWeight: 500,
            color: 'var(--t-text-faint)',
            letterSpacing: '-0.005em',
            whiteSpace: 'nowrap',
            fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
          }}
        >
          <span>{chat.runtimeLabel}</span>
          {tab.repo?.name ? (
            <>
              <span style={{ color: 'var(--t-text-faint)' }}>·</span>
              <span>{tab.repo.name}</span>
            </>
          ) : null}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          <WorkspaceCliModelPicker
            selected={chat.selectedModel}
            models={chat.availableModels}
            disabled={chat.sending}
            agentRunning={chat.agentRunning}
            runtimeLabel={chat.runtimeLabel}
            onSelect={(modelId) => chat.onSelectModel(chat.tabId, modelId)}
          />
        </div>
      </div>
    </div>
  );
}

export const WorkspaceChatComposer = memo(WorkspaceChatComposerBase);
