'use client';

import { memo } from 'react';
import {
  MessageSquare,
  X,
} from '../lucide-shims';
import {
  THEME_ACCENT,
  THEME_ACCENT_SOFT,
  THEME_BG_CARD,
} from '@/components/desktop/workspace-terminal/constants';
import type { TerminalTab } from '@/components/desktop/workspace-terminal/types';
import type { useWorkspaceChatPane } from '@/components/desktop/workspace-terminal/useWorkspaceChatPane';

type ChatPaneState = ReturnType<typeof useWorkspaceChatPane>;

interface WorkspaceChatComposerProps {
  chat: ChatPaneState;
  tab: TerminalTab;
  isLaneArchived: boolean;
  onSaveCheckpoint: (tabId: string) => void;
  onRestoreLatestCheckpoint: (tabId: string) => void;
}

/**
 * Composer for Codex + Claude Code agent sessions. Mirrors the orchestrator
 * composer shape without exposing controls that spawned agents should not own.
 * Agent sessions can be steered, but model/runtime/checkpoint chrome stays out
 * of the input so the surface reads like one clean message box.
 */
function WorkspaceChatComposerBase({
  chat,
  isLaneArchived,
}: WorkspaceChatComposerProps) {
  const working = chat.agentRunning;
  const canSubmit = chat.canSend && !chat.sending;
  const interactive = !working && canSubmit;
  const iconColor = interactive ? '#ffffff' : 'var(--t-text-faint)';
  const title = working ? 'Agent working…' : canSubmit ? 'Send (Enter)' : 'Type to send';

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
              fontFamily: 'var(--font-sans-system)',
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
            justifyContent: 'flex-end',
            gap: 6,
            paddingTop: 2,
            paddingBottom: 8,
            paddingLeft: 10,
            paddingRight: 8,
          }}
        >
          <button
            type="button"
            onClick={() => void chat.handleSend()}
            disabled={!interactive}
            title={title}
            aria-label={title}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 32,
              height: 32,
              paddingTop: 0,
              paddingRight: 0,
              paddingBottom: 0,
              paddingLeft: 0,
              borderRadius: 10,
              borderWidth: interactive ? 0 : 1,
              borderStyle: 'solid',
              borderColor: 'var(--t-border)',
              background: interactive ? '#2563eb' : 'transparent',
              color: iconColor,
              cursor: interactive ? 'pointer' : 'default',
              flexShrink: 0,
              transition: 'background 180ms cubic-bezier(0.22, 1, 0.36, 1), opacity 180ms cubic-bezier(0.22, 1, 0.36, 1)',
              opacity: working ? 0.7 : 1,
              animation: working ? 'sendpill-pulse 1.6s ease-in-out infinite' : 'none',
            }}
          >
            {working ? (
              <svg width={13} height={13} viewBox="0 0 16 16" fill={iconColor} style={{ display: 'block' }} aria-hidden="true">
                <rect x="4" y="3" width="3" height="10" rx="1" />
                <rect x="9" y="3" width="3" height="10" rx="1" />
              </svg>
            ) : (
              <svg width={13} height={13} viewBox="0 0 16 16" fill={iconColor} style={{ display: 'block' }} aria-hidden="true">
                <path d="M5 3l8 5-8 5V3z" />
              </svg>
            )}
            <style>{`@keyframes sendpill-pulse { 0%,100% { opacity: 1 } 50% { opacity: 0.6 } }`}</style>
          </button>
        </div>
      </div>
    </div>
  );
}

export const WorkspaceChatComposer = memo(WorkspaceChatComposerBase);
