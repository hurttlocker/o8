'use client';

import { Suspense, lazy, type CSSProperties } from 'react';
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  FileText,
  Lightbulb,
  MessageSquare,
  Plus,
  RotateCcw,
  Search,
  Square,
  X,
} from 'lucide-react';
import { IssueLinkPickerModal, type LinkedIssueRef } from '@/components/desktop/IssueLinkPicker';
import { LIGHT_CANVAS_VARS } from '@/components/desktop/canvas-utils';
import {
  CLI_SUGGESTED_PROMPTS,
  THEME_ACCENT,
  THEME_ACCENT_BORDER,
  THEME_ACCENT_RING,
  THEME_ACCENT_SOFT,
  THEME_BG_CARD,
  THEME_PANEL_GLASS,
} from '@/components/desktop/workspace-terminal/constants';
import type { TerminalTab } from '@/components/desktop/workspace-terminal/types';
import { useWorkspaceChatPane } from '@/components/desktop/workspace-terminal/useWorkspaceChatPane';
import { WorkspaceCliModelPicker } from '@/components/desktop/workspace-terminal/WorkspaceCliModelPicker';

const LazyMessageBubble = lazy(() => import('@/components/desktop/LLMChat').then((module) => ({ default: module.MessageBubble })));
const LazyChainOfThought = lazy(() => import('@/components/desktop/LLMChat').then((module) => ({ default: module.ChainOfThought })));

interface WorkspaceChatPaneProps {
  tab: TerminalTab;
  active: boolean;
  onUpdateMessages: (tabId: string, messages: import('@/lib/mobile/types').MobileTranscriptEntry[]) => void;
  onUpdateSessionKey: (tabId: string, sessionKey: string) => void;
  onRunInTerminal?: (command: string) => void;
  onSelectModel: (tabId: string, modelId: string) => void;
  onConsumeDraftInjection: (tabId: string, injectionId: string) => void;
  onLinkedIssueChange: (tabId: string, issue: LinkedIssueRef | null) => void;
  onSaveCheckpoint: (tabId: string) => void;
  onRestoreLatestCheckpoint: (tabId: string) => void;
}

function PromptGlyph({ icon }: { icon: string }) {
  if (icon === 'Idea') return <Lightbulb size={16} />;
  if (icon === 'Search') return <Search size={16} />;
  if (icon === 'Test') return <AlertCircle size={16} />;
  return <FileText size={16} />;
}

export function WorkspaceChatPane({
  tab,
  active,
  onUpdateMessages,
  onUpdateSessionKey,
  onRunInTerminal,
  onSelectModel,
  onConsumeDraftInjection,
  onLinkedIssueChange,
  onSaveCheckpoint,
  onRestoreLatestCheckpoint,
}: WorkspaceChatPaneProps) {
  const chat = useWorkspaceChatPane({
    tab,
    active,
    onUpdateMessages,
    onUpdateSessionKey,
    onSelectModel,
    onConsumeDraftInjection,
  });

  return (
    <div
      data-vibrancy-passthrough=""
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
        background: '#ffffff',
        ...LIGHT_CANVAS_VARS,
        position: 'relative',
      } as CSSProperties}
    >
      <div
        ref={chat.scrollRef}
        onScroll={chat.handleScroll}
        style={{
          flex: 1,
          overflowY: 'auto',
          paddingTop: chat.llmMessages.length === 0 && !chat.agentRunning ? 0 : 24,
          paddingBottom: 24,
          paddingLeft: 24,
          paddingRight: 24,
          background: 'transparent',
          scrollbarWidth: 'thin',
        }}
      >
        {chat.visibleMessages.length === 0 && !chat.agentRunning ? (
          chat.isAgentTab ? (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                height: '100%',
                gap: 16,
                animation: 'llmFadeIn 400ms ease-out',
              }}
            >
              <div
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: 12,
                  background: 'rgba(37, 99, 235, 0.08)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="#2563eb" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 2v4m0 12v4M4.93 4.93l2.83 2.83m8.48 8.48l2.83 2.83M2 12h4m12 0h4M4.93 19.07l2.83-2.83m8.48-8.48l2.83-2.83" />
                </svg>
              </div>
              <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--t-text)', letterSpacing: '-0.01em' }}>
                Connecting to agent...
              </div>
              <div
                style={{
                  fontSize: 12,
                  color: 'var(--t-text-secondary)',
                  textAlign: 'center',
                  maxWidth: 320,
                  lineHeight: 1.5,
                }}
              >
                Waiting for transcript from the {chat.runtimeLabel} session. You can type a message below to steer the agent.
              </div>
            </div>
          ) : (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                height: '100%',
                gap: 32,
                animation: 'llmFadeIn 400ms ease-out',
              }}
            >
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
                <div
                  style={{
                    width: 48,
                    height: 48,
                    borderRadius: 14,
                    background: `linear-gradient(135deg, ${THEME_ACCENT} 0%, #8b5cf6 100%)`,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    boxShadow: `0 4px 16px ${THEME_ACCENT_RING}`,
                  }}
                >
                  <MessageSquare size={24} style={{ color: '#ffffff' }} />
                </div>
                <div style={{ fontSize: 24, fontWeight: 600, color: 'var(--t-text-strong)', letterSpacing: '-0.02em' }}>
                  {(() => {
                    const hour = new Date().getHours();
                    const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
                    return `${greeting}. What can I help you build?`;
                  })()}
                </div>
                <div
                  style={{
                    fontSize: 14,
                    color: 'var(--t-text-muted)',
                    textAlign: 'center',
                    maxWidth: 420,
                    lineHeight: 1.5,
                  }}
                >
                  Chat with {chat.selectedModel.label} scoped to this {chat.runtimeLabel} lane{tab.repo ? ` in ${tab.repo.name}` : ''}.
                </div>
              </div>

              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(2, 1fr)',
                  gap: 10,
                  maxWidth: 560,
                  width: '100%',
                }}
              >
                {CLI_SUGGESTED_PROMPTS.map((prompt, index) => (
                  <button
                    key={prompt.text}
                    type="button"
                    onClick={() => {
                      chat.setDraft(prompt.text);
                      setTimeout(() => chat.composeRef.current?.focus(), 50);
                    }}
                    style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: 10,
                      paddingTop: 14,
                      paddingBottom: 14,
                      paddingLeft: 14,
                      paddingRight: 14,
                      background: THEME_BG_CARD,
                      border: '1px solid var(--t-panel-border)',
                      borderRadius: 12,
                      cursor: 'pointer',
                      textAlign: 'left',
                      transition: 'all 150ms ease',
                      animation: `llmFadeIn 400ms ease-out ${100 + index * 50}ms both`,
                    }}
                    onMouseEnter={(event) => {
                      event.currentTarget.style.borderColor = THEME_ACCENT_BORDER;
                      event.currentTarget.style.background = THEME_ACCENT_SOFT;
                      event.currentTarget.style.transform = 'translateY(-1px)';
                      event.currentTarget.style.boxShadow = `0 2px 8px ${THEME_ACCENT_RING}`;
                    }}
                    onMouseLeave={(event) => {
                      event.currentTarget.style.borderColor = 'var(--t-panel-border)';
                      event.currentTarget.style.background = THEME_BG_CARD;
                      event.currentTarget.style.transform = 'translateY(0)';
                      event.currentTarget.style.boxShadow = 'none';
                    }}
                  >
                    <span style={{ lineHeight: 1, flexShrink: 0, color: THEME_ACCENT }}>
                      <PromptGlyph icon={prompt.icon} />
                    </span>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                      <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--t-text)', lineHeight: 1.3 }}>
                        {prompt.text}
                      </span>
                      <span style={{ fontSize: 11, color: 'var(--t-text-muted)', lineHeight: 1.4 }}>
                        {prompt.description}
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )
        ) : (
          <Suspense fallback={null}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 720, marginLeft: 'auto', marginRight: 'auto' }}>
              {chat.visibleMessages.map((message, index) => (
                <LazyMessageBubble
                  key={message.id}
                  message={message}
                  isLast={index === chat.visibleMessages.length - 1 && !chat.sending}
                  onRetry={message.role === 'assistant' ? () => chat.handleRetry(message.id) : undefined}
                  onEdit={message.role === 'user' ? (content) => chat.handleEdit(message.id, content) : undefined}
                  onDelete={() => chat.handleDelete(message.id)}
                  onRunInTerminal={onRunInTerminal}
                />
              ))}
              {chat.agentRunning && chat.activeThinking && chat.activeThinking.steps.length > 0 ? (
                <LazyChainOfThought
                  steps={chat.activeThinking.steps}
                  thinking={chat.activeThinking.thinking}
                  durationMs={chat.streamMeta.thinkingDurationMs}
                  isLive
                />
              ) : null}
              {chat.agentRunning ? (
                <LazyMessageBubble
                  message={{
                    id: `stream:${chat.tabId}`,
                    role: 'assistant',
                    content: chat.streamingText || 'Thinking...',
                    model: chat.selectedModel.label,
                    timestamp: Date.now(),
                    tokens: chat.streamMeta.tokens,
                    costUsd: chat.streamMeta.costUsd,
                    sources: chat.streamMeta.sources,
                    recalledFacts: chat.streamMeta.recalledFacts,
                    toolCalls: chat.activeToolCalls.map((tool) => ({
                      name: tool.name,
                      status: tool.status ?? 'running',
                      args: tool.args,
                      preview: tool.preview,
                    })),
                  }}
                  isLast
                  onRunInTerminal={onRunInTerminal}
                />
              ) : null}
              {!chat.agentRunning && chat.isRuntimeBound && chat.supervisorActive && chat.messages.length > 0 ? (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    paddingTop: 12,
                    paddingRight: 16,
                    paddingBottom: 12,
                    paddingLeft: 16,
                  }}
                >
                  <div style={{ display: 'flex', gap: 3, alignItems: 'center' }}>
                    {[0, 1, 2].map((index) => (
                      <span
                        key={index}
                        style={{
                          width: 5,
                          height: 5,
                          borderRadius: '50%',
                          background: '#22c55e',
                          opacity: 0.4,
                          animation: `o8ThinkPulse 1.4s ease-in-out ${index * 0.2}s infinite`,
                        }}
                      />
                    ))}
                  </div>
                  <span style={{ fontSize: 11, color: 'var(--t-text-faint)', fontFamily: '-apple-system, system-ui, sans-serif', fontWeight: 500 }}>
                    Agent working...
                  </span>
                  <style>{'@keyframes o8ThinkPulse { 0%, 80%, 100% { opacity: 0.25; transform: scale(0.8); } 40% { opacity: 1; transform: scale(1.1); } }'}</style>
                </div>
              ) : null}
            </div>
          </Suspense>
        )}
      </div>

      {chat.showScrollToBottom && (chat.llmMessages.length > 0 || chat.agentRunning) ? (
        <div style={{ position: 'absolute', right: 30, bottom: 104, zIndex: 40, animation: 'llmFadeIn 150ms ease-out' }}>
          <button
            type="button"
            onClick={() => {
              chat.scrollToBottom(true);
            }}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 7,
              minHeight: 34,
              paddingTop: 7,
              paddingBottom: 7,
              paddingLeft: 12,
              paddingRight: 12,
              borderRadius: 999,
              border: `1px solid ${THEME_ACCENT_BORDER}`,
              background: THEME_PANEL_GLASS,
              color: THEME_ACCENT,
              boxShadow: `0 12px 28px ${THEME_ACCENT_RING}`,
              backdropFilter: 'blur(18px)',
              WebkitBackdropFilter: 'blur(18px)',
              cursor: 'pointer',
              fontSize: 11,
              fontWeight: 700,
              fontFamily: '-apple-system, system-ui, sans-serif',
            } as CSSProperties}
          >
            <ArrowDown size={13} />
            Bottom messages
          </button>
        </div>
      ) : null}

      <div
        style={{
          paddingTop: 12,
          paddingBottom: 16,
          paddingLeft: 24,
          paddingRight: 24,
          borderTop: '1px solid var(--t-divider)',
          background: 'transparent',
        }}
      >
        <div
          style={{
            maxWidth: 720,
            marginLeft: 'auto',
            marginRight: 'auto',
            border: '1px solid var(--t-panel-border)',
            borderRadius: 18,
            background: THEME_PANEL_GLASS,
            transition: 'border-color 200ms, box-shadow 200ms',
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
                      width: 28,
                      height: 28,
                      borderRadius: 10,
                      border: '1px solid var(--t-btn-secondary-border)',
                      background: 'var(--t-btn-secondary-bg)',
                      color: 'var(--t-text)',
                      cursor: 'pointer',
                      flexShrink: 0,
                      boxShadow: '0 1px 2px rgba(15, 23, 42, 0.06)',
                    }}
                  >
                    <span
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        width: 14,
                        height: 14,
                        lineHeight: 0,
                        color: 'var(--t-text-secondary)',
                      }}
                    >
                      <X size={13} />
                    </span>
                  </button>
                </div>
              ))}
            </div>
          ) : null}

          <div style={{ paddingTop: 14, paddingBottom: 8, paddingLeft: 18, paddingRight: 18 }}>
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
              rows={1}
              style={{
                width: '100%',
                border: 'none',
                outline: 'none',
                background: 'transparent',
                color: 'var(--t-text)',
                fontSize: 14,
                fontFamily: '-apple-system, system-ui, sans-serif',
                lineHeight: 1.5,
                resize: 'none',
                minHeight: 24,
                maxHeight: 200,
                boxSizing: 'border-box',
              }}
            />
          </div>

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              paddingTop: 4,
              paddingBottom: 10,
              paddingLeft: 14,
              paddingRight: 10,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <button
                type="button"
                disabled
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 30,
                  height: 30,
                  borderRadius: 8,
                  border: 'none',
                  background: 'transparent',
                  color: 'var(--t-text-faint)',
                  cursor: 'default',
                }}
                title="Attachments coming soon"
              >
                <Plus size={16} />
              </button>
              <span style={{ fontSize: 10, color: 'var(--t-text-faint)', fontFamily: '-apple-system, system-ui, sans-serif' }}>
                CLI session
              </span>
              <button
                type="button"
                onClick={() => chat.setIssuePickerOpen(true)}
                title={chat.linkedIssue ? `${chat.linkedIssue.title}` : 'Link a GitHub issue to this chat'}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  minHeight: 28,
                  paddingTop: 0,
                  paddingBottom: 0,
                  paddingLeft: 10,
                  paddingRight: 10,
                  borderRadius: 999,
                  border: chat.linkedIssue ? `1px solid ${THEME_ACCENT_BORDER}` : '1px solid var(--t-panel-border)',
                  background: chat.linkedIssue ? THEME_ACCENT_SOFT : THEME_BG_CARD,
                  color: chat.linkedIssue ? THEME_ACCENT : 'var(--t-text-secondary)',
                  cursor: 'pointer',
                  fontSize: 11,
                  fontWeight: 700,
                  fontFamily: '-apple-system, system-ui, sans-serif',
                  whiteSpace: 'nowrap',
                }}
              >
                <AlertCircle size={13} />
                {chat.linkedIssue ? `Issue #${chat.linkedIssue.number}` : 'Link issue'}
              </button>
              <button
                type="button"
                onClick={() => onSaveCheckpoint(chat.tabId)}
                disabled={chat.messages.length === 0}
                title={chat.messages.length === 0 ? 'Checkpoint becomes available once this chat has transcript history' : 'Save a safe checkpoint from this chat'}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  minHeight: 28,
                  paddingTop: 0,
                  paddingBottom: 0,
                  paddingLeft: 10,
                  paddingRight: 10,
                  borderRadius: 999,
                  border: '1px solid var(--t-panel-border)',
                  background: THEME_BG_CARD,
                  color: chat.messages.length === 0 ? 'var(--t-text-faint)' : 'var(--t-text-secondary)',
                  cursor: chat.messages.length === 0 ? 'default' : 'pointer',
                  fontSize: 11,
                  fontStyle: 'italic',
                  fontWeight: 700,
                  fontFamily: '-apple-system, system-ui, sans-serif',
                  whiteSpace: 'nowrap',
                }}
              >
                <AlertCircle size={13} />
                Checkpoint
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
                    minHeight: 28,
                    paddingTop: 0,
                    paddingBottom: 0,
                    paddingLeft: 10,
                    paddingRight: 10,
                    borderRadius: 999,
                    border: `1px solid ${THEME_ACCENT_BORDER}`,
                    background: THEME_ACCENT_SOFT,
                    color: THEME_ACCENT,
                    cursor: 'pointer',
                    fontSize: 11,
                    fontStyle: 'italic',
                    fontWeight: 700,
                    fontFamily: '-apple-system, system-ui, sans-serif',
                    whiteSpace: 'nowrap',
                  }}
                >
                  <RotateCcw size={13} />
                  Restore latest
                </button>
              ) : null}
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <WorkspaceCliModelPicker
                selected={chat.selectedModel}
                models={chat.availableModels}
                disabled={chat.sending}
                onSelect={(modelId) => chat.onSelectModel(chat.tabId, modelId)}
              />
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  background: chat.agentRunning ? '#22c55e' : 'var(--t-divider-strong)',
                }}
              />
              {chat.agentRunning ? (
                <button
                  type="button"
                  disabled
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: 32,
                    height: 32,
                    border: 'none',
                    borderRadius: 10,
                    background: '#ef4444',
                    color: '#ffffff',
                    cursor: 'default',
                    flexShrink: 0,
                  }}
                >
                  <Square size={14} />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => void chat.handleSend()}
                  disabled={!chat.canSend || chat.sending}
                  title="Send message (Enter)"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: 32,
                    height: 32,
                    border: 'none',
                    borderRadius: 10,
                    background: chat.canSend ? THEME_ACCENT : 'var(--t-divider-strong)',
                    color: chat.canSend ? '#ffffff' : 'var(--t-text-faint)',
                    cursor: chat.canSend ? 'pointer' : 'default',
                    flexShrink: 0,
                    transition: 'all 150ms',
                  }}
                >
                  <ArrowUp size={16} />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      <IssueLinkPickerModal
        open={chat.issuePickerOpen}
        onClose={() => chat.setIssuePickerOpen(false)}
        value={chat.linkedIssue}
        preferredRepo={tab.repo ?? null}
        onSelect={(issue) => onLinkedIssueChange(chat.tabId, issue)}
        onClear={() => onLinkedIssueChange(chat.tabId, null)}
      />
    </div>
  );
}
