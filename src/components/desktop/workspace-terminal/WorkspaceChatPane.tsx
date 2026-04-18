'use client';

import { Suspense, lazy, memo, useMemo, type CSSProperties } from 'react';
import {
  AlertCircle,
  ArrowDown,
  CheckCircle2,
  FileText,
  Lightbulb,
  MessageSquare,
  Search,
} from '../lucide-shims';
import { useLaneArchivedView } from '@/app/dashboard/hooks/useLaneArchivedSet';
import { IssueLinkPickerModal, type LinkedIssueRef } from '@/components/desktop/IssueLinkPicker';
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
import { WorkspaceChatComposer } from '@/components/desktop/workspace-terminal/WorkspaceChatComposer';

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

function WorkspaceChatPaneBase({
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

  // When the lane bound to this tab's session has been archived (reviewed +
  // merged, reaped for a missing worktree, or explicitly archived by the
  // operator), we flip the composer into read-only mode with a dismissible
  // banner. The transcript stays visible so the user can still scroll the
  // history, but they can't send new turns to a retired session.
  const archivedLaneView = useLaneArchivedView();
  const isLaneArchived = useMemo(() => {
    if (tab.kind !== 'chat') return false;
    const sessionKey = tab.chatSessionKey;
    return sessionKey ? archivedLaneView.sessionKeys.has(sessionKey) : false;
  }, [tab.kind, tab.chatSessionKey, archivedLaneView.sessionKeys]);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
        background: 'var(--t-chat-surface-bg, #ffffff)',
        color: 'var(--t-chat-surface-text, var(--t-text))',
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
                  <span style={{ fontSize: 11, color: 'var(--t-text-faint)', fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif', fontWeight: 500 }}>
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
              fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
            } as CSSProperties}
          >
            <ArrowDown size={13} />
            Bottom messages
          </button>
        </div>
      ) : null}

      {isLaneArchived ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 10,
            paddingTop: 12,
            paddingBottom: 12,
            paddingLeft: 20,
            paddingRight: 20,
            borderTop: '1px solid var(--t-divider)',
            background: 'linear-gradient(180deg, rgba(34, 197, 94, 0.06), rgba(34, 197, 94, 0.02))',
            color: 'var(--t-text-secondary)',
            fontSize: 12,
            fontWeight: 600,
            letterSpacing: '-0.005em',
          }}
        >
          <CheckCircle2 size={14} style={{ color: '#22c55e', flexShrink: 0 }} />
          <span>Merged · read-only</span>
          <span style={{ color: 'var(--t-text-muted)', fontWeight: 500 }}>
            This session's lane has been archived. The transcript stays for review.
          </span>
        </div>
      ) : null}

      <WorkspaceChatComposer
        chat={chat}
        tab={tab}
        isLaneArchived={isLaneArchived}
        onSaveCheckpoint={onSaveCheckpoint}
        onRestoreLatestCheckpoint={onRestoreLatestCheckpoint}
      />

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

export const WorkspaceChatPane = memo(WorkspaceChatPaneBase);
