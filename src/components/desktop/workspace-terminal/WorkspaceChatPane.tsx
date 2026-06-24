'use client';

import { Suspense, lazy, memo, useEffect, useMemo, useState, type CSSProperties } from 'react';
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
import { useSharedDesktopWs } from '@/components/desktop/hooks/DesktopWebSocketContext';
import { useOrchestratorData } from '@/components/desktop/orchestrator-data-context';
import { IssueLinkPickerModal, type LinkedIssueRef } from '@/components/desktop/IssueLinkPicker';
import type { RealtimeEventEnvelope, RealtimeMutationRecord } from '@/lib/realtime/types';
import {
  CLI_SUGGESTED_PROMPTS,
  THEME_ACCENT,
  THEME_ACCENT_BORDER,
  THEME_ACCENT_RING,
  THEME_ACCENT_SOFT,
  THEME_BG_CARD,
} from '@/components/desktop/workspace-terminal/constants';
import type { TerminalTab } from '@/components/desktop/workspace-terminal/types';
import { useWorkspaceChatPane } from '@/components/desktop/workspace-terminal/useWorkspaceChatPane';
import { WorkspaceChatComposer } from '@/components/desktop/workspace-terminal/WorkspaceChatComposer';
import { ChatPacketStatusBanner } from '@/components/desktop/workspace-terminal/ChatPacketStatusBanner';
import { PacketHeaderCard } from '@/components/desktop/workspace-terminal/PacketHeaderCard';
import {
  WorkspaceRichChatEvents,
  stripWorkspaceRichRendererFallback,
} from '@/components/desktop/workspace-terminal/chat-renderers/WorkspaceRichChatEvents';

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

// A dispatched-packet prompt is a large, structured brief. We collapse it into a
// PacketHeaderCard so the transcript doesn't open with a wall of text — but the
// gate used to require `tab.orchestrationPacket`, which is dropped when a tab is
// reconstructed from session discovery (the packet metadata doesn't survive).
// Detect the prompt by the markers the dispatcher always emits so the card shows
// regardless of whether the badge metadata is present.
function looksLikePacketPrompt(text: string): boolean {
  if (!text || text.length < 400) return false;
  return /##\s*Project\s+(Brief|Scope|Directives)\b/i.test(text)
    || /(^|\n)\s*Packet:\s/i.test(text)
    || /(^|\n)\s*STRICT SCOPE:/i.test(text);
}

function WorkspaceChatPaneBase({
  tab,
  // `active` (tab focused/visible) gates the transcript re-fetch + live poll in
  // useWorkspaceChatPane, so a dispatched packet's transcript loads on view and
  // streams while the agent is working.
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

  // Live packet status — the orchestrationPacket badge stored on the tab is
  // a snapshot at openCliChatSession time. The mission state knows the
  // current status (running → awaiting_review → released → archived);
  // resolve it by sessionKey so the PacketHeaderCard reflects reality.
  const orchestratorData = useOrchestratorData();
  const livePacket = useMemo(() => {
    if (!tab.orchestrationPacket) return null;
    const targetSessionKey = chat.normalizedSessionKey ?? tab.id;
    const targetPacketId = tab.orchestrationPacket.packetId ?? null;
    return orchestratorData?.missionState?.packets.find((p) => (
      (targetPacketId && p.id === targetPacketId)
      || (targetSessionKey && p.lane?.sessionKey === targetSessionKey)
    )) ?? null;
  }, [chat.normalizedSessionKey, orchestratorData?.missionState?.packets, tab.id, tab.orchestrationPacket]);
  const liveStatus = livePacket?.status ?? tab.orchestrationPacket?.status ?? null;

  // When the lane bound to this tab's session has been archived (reviewed +
  // merged, reaped for a missing worktree, or explicitly archived by the
  // operator), we flip the composer into read-only mode with a dismissible
  // banner. The transcript stays visible so the user can still scroll the
  // history, but they can't send new turns to a retired session.
  const archivedLaneView = useLaneArchivedView();
  // A lane is "retired" (merged + archived → read-only) when ANY reliable
  // signal says so. We OR several because the session-key form drifts between
  // raw (`codex-owned:abc`), normalized (`codex:abc`), and whatever the
  // lane-lifecycle event payload carried. The old check keyed only on the raw
  // `tab.chatSessionKey`, so two sibling tabs from the same mission disagreed —
  // one flipped to read-only while the other stayed stuck on "Agent working…".
  // Packet status + the archived packetId set don't drift, so they anchor it.
  const laneRetired = useMemo(() => {
    if (tab.kind !== 'chat') return false;
    if (liveStatus === 'released' || liveStatus === 'archived') return true;
    const packetId = livePacket?.id ?? tab.orchestrationPacket?.packetId ?? null;
    if (packetId && archivedLaneView.packetIds.has(packetId)) return true;
    const candidateKeys = [tab.chatSessionKey, chat.normalizedSessionKey, livePacket?.lane?.sessionKey];
    return candidateKeys.some((key) => Boolean(key) && archivedLaneView.sessionKeys.has(key as string));
  }, [tab.kind, tab.chatSessionKey, tab.orchestrationPacket?.packetId, chat.normalizedSessionKey, liveStatus, livePacket, archivedLaneView]);

  // A retired lane is NOT necessarily a merged one. The old banner said "Merged"
  // for every archived lane — including ones the operator stopped or reset, and
  // ones that failed — which is a lie (operator flagged it 2026-06-22). Derive
  // the real outcome: `releaseState === 'released'` is the sticky merge signal
  // (set at merge, survives archival even when status flips to 'archived'); a
  // `failed` status is a failure; anything else retired was archived without
  // ever merging. Only the genuine-merge branch gets the green "Merged" check.
  const retirement = useMemo(() => {
    const merged = liveStatus === 'released' || livePacket?.releaseState === 'released';
    if (merged) {
      return {
        merged: true,
        tone: '#22c55e',
        iconBg: 'rgba(34, 197, 94, 0.10)',
        heroTitle: 'Merged & archived',
        heroSub: `This ${chat.runtimeLabel} session shipped and its lane was archived. The live transcript isn’t available here.`,
        bannerLabel: 'Merged · read-only',
        bannerSub: 'This session’s lane merged and was archived. The transcript stays for review.',
      };
    }
    if (liveStatus === 'failed') {
      return {
        merged: false,
        tone: '#f59e0b',
        iconBg: 'rgba(245, 158, 11, 0.10)',
        heroTitle: 'Ended without merging',
        heroSub: `This ${chat.runtimeLabel} session ended without merging and its lane was archived.`,
        bannerLabel: 'Ended · read-only',
        bannerSub: 'This session ended without merging. The transcript stays for review.',
      };
    }
    return {
      merged: false,
      tone: 'var(--t-text-muted)',
      iconBg: 'var(--t-panel)',
      heroTitle: 'Archived',
      heroSub: `This ${chat.runtimeLabel} session’s lane was archived without merging.`,
      bannerLabel: 'Archived · read-only',
      bannerSub: 'This session’s lane was archived without merging. The transcript stays for review.',
    };
  }, [liveStatus, livePacket?.releaseState, chat.runtimeLabel]);

  // Runtime fallback notifications: when a Gemini model quotas out, the
  // adapter picks the next model in GEMINI_FALLBACK_CASCADE before retrying.
  // The store publishes a `runtime-fallback` mutation; we render it as a
  // dismissible pill above the transcript for ~12s.
  const [fallbackPill, setFallbackPill] = useState<{ fromModel: string; toModel: string; reason: string } | null>(null);
  const tabSessionKey = tab.chatSessionKey ?? null;
  useSharedDesktopWs(undefined, useMemo(() => ({
    onRealtimeEvent: (event: RealtimeEventEnvelope) => {
      if (event.channel !== 'mutation') return;
      if (event.event !== 'mutation.record' && event.event !== 'mutation.settled') return;
      const mutation = (event.data as { mutation?: RealtimeMutationRecord }).mutation;
      if (!mutation || mutation.action !== 'runtime-fallback') return;
      if (!tabSessionKey) return;
      if (mutation.sessionKey && !tabSessionKey.endsWith(mutation.sessionKey)) return;
      const fromModel = mutation.fromModel ?? '';
      const toModel = mutation.toModel ?? '';
      const reason = mutation.reason ?? mutation.note ?? '';
      if (!toModel) return;
      setFallbackPill({ fromModel, toModel, reason });
    },
  }), [tabSessionKey]));
  useEffect(() => {
    if (!fallbackPill) return;
    const timer = window.setTimeout(() => setFallbackPill(null), 12_000);
    return () => window.clearTimeout(timer);
  }, [fallbackPill]);

  const [streamingTimestamp, setStreamingTimestamp] = useState<number | null>(null);
  useEffect(() => {
    if (!chat.agentRunning) {
      setStreamingTimestamp(null);
      return;
    }
    setStreamingTimestamp(Date.now());
  }, [chat.agentRunning, chat.tabId]);

  const streamingMessage = useMemo<import('@/components/desktop/LLMChat').LLMMessage>(() => ({
    id: `stream:${chat.tabId}`,
    role: 'assistant',
    content: chat.streamingText || 'Thinking...',
    model: chat.selectedModel.label,
    timestamp: streamingTimestamp ?? 0,
    tokens: chat.streamMeta.tokens,
    costUsd: chat.streamMeta.costUsd,
    sources: chat.streamMeta.sources,
    recalledFacts: chat.streamMeta.recalledFacts,
    claudeCodeEvents: chat.activeClaudeCodeEvents,
    toolCalls: chat.activeToolCalls.map((tool) => ({
      name: tool.name,
      status: tool.status ?? 'running',
      args: tool.args,
      preview: tool.preview,
    })),
  }), [chat.tabId, chat.streamingText, chat.selectedModel.label, streamingTimestamp, chat.streamMeta, chat.activeClaudeCodeEvents, chat.activeToolCalls]);

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
      {fallbackPill ? (
        <div
          style={{
            position: 'absolute',
            top: 12,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 30,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 10,
            paddingTop: 8,
            paddingBottom: 8,
            paddingLeft: 14,
            paddingRight: 14,
            borderRadius: 999,
            background: 'rgba(245, 158, 11, 0.12)',
            borderWidth: '0.5px',
            borderStyle: 'solid',
            borderColor: 'rgba(245, 158, 11, 0.35)',
            boxShadow: '0 4px 14px rgba(245, 158, 11, 0.18)',
            fontFamily: 'var(--font-sans-system)',
            fontSize: 12,
            fontWeight: 500,
            letterSpacing: '-0.005em',
            color: '#92400e',
            cursor: 'pointer',
            animation: 'llmFadeIn 280ms ease-out',
          }}
          onClick={() => setFallbackPill(null)}
          title="Click to dismiss"
        >
          <AlertCircle size={13} style={{ flexShrink: 0 }} />
          <span>
            Switched to <strong style={{ fontWeight: 600 }}>{fallbackPill.toModel}</strong>
            {fallbackPill.reason ? ` — ${fallbackPill.reason.replace(/\.$/, '')}` : ''}
          </span>
        </div>
      ) : null}
      <div
        ref={chat.scrollRef}
        onScroll={chat.handleScroll}
        className="cortex-scroll-fade-y cortex-themed-scroll"
        style={{
          flex: 1,
          overflowY: 'auto',
          paddingTop: chat.llmMessages.length === 0 && !chat.agentRunning ? 0 : 24,
          paddingBottom: 24,
          paddingLeft: 'var(--cortex-chat-gutter)',
          paddingRight: 'var(--cortex-chat-gutter)',
          background: 'transparent',
        }}
      >
        {chat.visibleMessages.length === 0 && !chat.agentRunning ? (
          chat.isAgentTab ? (
            laneRetired ? (
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  height: '100%',
                  gap: 14,
                  animation: 'llmFadeIn 400ms ease-out',
                }}
              >
                <div
                  style={{
                    width: 40,
                    height: 40,
                    borderRadius: 12,
                    background: retirement.iconBg,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  {retirement.merged ? (
                    <CheckCircle2 size={20} style={{ color: retirement.tone }} />
                  ) : (
                    <AlertCircle size={20} style={{ color: retirement.tone }} />
                  )}
                </div>
                <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--t-text)', letterSpacing: '-0.01em' }}>
                  {retirement.heroTitle}
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
                  {retirement.heroSub}
                </div>
                {orchestratorData?.onOpenO8Panel ? (
                  <button
                    type="button"
                    onClick={() => orchestratorData.onOpenO8Panel?.({ tab: 'activity' })}
                    style={{
                      marginTop: 2,
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                      height: 28,
                      paddingLeft: 12,
                      paddingRight: 12,
                      borderRadius: 999,
                      borderWidth: 1,
                      borderStyle: 'solid',
                      borderColor: 'var(--t-border)',
                      background: 'var(--t-panel)',
                      color: 'var(--t-text-muted)',
                      cursor: 'pointer',
                      fontSize: 11,
                      fontWeight: 500,
                      fontFamily: 'var(--font-sans-system)',
                    }}
                  >
                    View in Activity
                  </button>
                ) : null}
              </div>
            ) : (
              // Empty transcript but the lane is live. Codex `exec --json`
              // streams to the lane (Activity), NOT into this session's
              // transcript slice — so a dispatched (un-steered) packet keeps an
              // empty slice forever. Reflect the REAL lane lifecycle
              // (`liveStatus`) instead of a perpetual, misleading "Connecting /
              // waiting for transcript". (#1293)
              (() => {
                const awaitingReview = liveStatus === 'awaiting_review';
                const showBanner = liveStatus === 'awaiting_review'
                  || liveStatus === 'failed'
                  || liveStatus === 'recovering';
                return (
                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      justifyContent: 'center',
                      height: '100%',
                      gap: 14,
                      animation: 'llmFadeIn 400ms ease-out',
                    }}
                  >
                    <div
                      style={{
                        width: 40,
                        height: 40,
                        borderRadius: 12,
                        background: awaitingReview ? 'rgba(245, 158, 11, 0.10)' : 'rgba(37, 99, 235, 0.08)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      {awaitingReview ? (
                        <CheckCircle2 size={20} style={{ color: '#b45309' }} />
                      ) : (
                        <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="#2563eb" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                          <path d="M12 2v4m0 12v4M4.93 4.93l2.83 2.83m8.48 8.48l2.83 2.83M2 12h4m12 0h4M4.93 19.07l2.83-2.83m8.48-8.48l2.83-2.83" />
                        </svg>
                      )}
                    </div>
                    <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--t-text)', letterSpacing: '-0.01em' }}>
                      {awaitingReview ? 'Ready for review' : 'Agent working…'}
                    </div>
                    <div
                      style={{
                        fontSize: 12,
                        color: 'var(--t-text-secondary)',
                        textAlign: 'center',
                        maxWidth: 340,
                        lineHeight: 1.5,
                      }}
                    >
                      {awaitingReview
                        ? `This ${chat.runtimeLabel} session finished and is awaiting review.`
                        : `${chat.runtimeLabel} is working in this lane — live activity streams to the Activity panel. Type below to steer it.`}
                    </div>
                    {tab.orchestrationPacket && livePacket && showBanner ? (
                      <div style={{ width: '100%', maxWidth: 440 }}>
                        <ChatPacketStatusBanner
                          status={liveStatus}
                          laneId={livePacket.lane?.laneId ?? null}
                          packetTitle={livePacket.title ?? tab.orchestrationPacket.title ?? null}
                          onOpenInActivity={
                            orchestratorData?.onOpenO8Panel
                              ? () => orchestratorData.onOpenO8Panel?.({ tab: 'activity' })
                              : undefined
                          }
                        />
                      </div>
                    ) : orchestratorData?.onOpenO8Panel ? (
                      <button
                        type="button"
                        onClick={() => orchestratorData.onOpenO8Panel?.({ tab: 'activity' })}
                        style={{
                          marginTop: 2,
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 6,
                          height: 28,
                          paddingLeft: 12,
                          paddingRight: 12,
                          borderRadius: 999,
                          borderWidth: 1,
                          borderStyle: 'solid',
                          borderColor: 'var(--t-border)',
                          background: 'var(--t-panel)',
                          color: 'var(--t-text-muted)',
                          cursor: 'pointer',
                          fontSize: 11,
                          fontWeight: 500,
                          fontFamily: 'var(--font-sans-system)',
                        }}
                      >
                        View in Activity
                      </button>
                    ) : null}
                  </div>
                );
              })()
            )
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
                      transition: 'all 150ms cubic-bezier(0.22, 1, 0.36, 1)',
                      animation: `llmFadeIn 400ms ease-out ${100 + index * 50}ms both`,
                    }}
                    onMouseEnter={(event) => {
                      event.currentTarget.style.borderColor = THEME_ACCENT_BORDER;
                      event.currentTarget.style.background = THEME_ACCENT_SOFT;
                      event.currentTarget.style.boxShadow = `0 2px 8px ${THEME_ACCENT_RING}`;
                    }}
                    onMouseLeave={(event) => {
                      event.currentTarget.style.borderColor = 'var(--t-panel-border)';
                      event.currentTarget.style.background = THEME_BG_CARD;
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
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%', maxWidth: 'var(--cortex-chat-column-max)', marginLeft: 'auto', marginRight: 'auto' }}>
              {chat.visibleMessages.map((message, index) => {
                // For dispatched packets: replace the FIRST user bubble (the
                // giant packet prompt) with a collapsible PacketHeaderCard so
                // the transcript doesn't open with a wall of text.
                const isFirstUser = index === 0 && message.role === 'user';
                const firstUserPrompt = isFirstUser
                  ? (typeof message.content === 'string' ? message.content : String(message.content ?? ''))
                  : '';
                if (isFirstUser && (tab.orchestrationPacket || looksLikePacketPrompt(firstUserPrompt))) {
                  return (
                    <PacketHeaderCard
                      key={message.id}
                      title={tab.orchestrationPacket?.title ?? tab.label ?? 'Dispatched packet'}
                      branch={tab.orchestrationPacket?.branchTarget ?? null}
                      runtime={tab.orchestrationPacket?.runtime ?? tab.chatRuntime ?? null}
                      status={liveStatus}
                      prompt={firstUserPrompt}
                    />
                  );
                }
                const bubbleMessage = stripWorkspaceRichRendererFallback(message);
                return (
                  <div key={message.id} style={{ display: 'flex', flexDirection: 'column', alignItems: message.role === 'user' ? 'flex-end' : 'flex-start' }}>
                    <LazyMessageBubble
                      message={bubbleMessage}
                      isLast={index === chat.visibleMessages.length - 1 && !chat.sending}
                      onRetry={message.role === 'assistant' ? () => chat.handleRetry(message.id) : undefined}
                      onEdit={message.role === 'user' ? (content) => chat.handleEdit(message.id, content) : undefined}
                      onDelete={() => chat.handleDelete(message.id)}
                      onRunInTerminal={onRunInTerminal}
                    />
                    {message.role === 'assistant' ? (
                      <WorkspaceRichChatEvents
                        message={message}
                        repoPath={tab.repo?.localPath}
                        onPermissionDecision={chat.handleClaudePermissionDecision}
                      />
                    ) : null}
                  </div>
                );
              })}
              {chat.agentRunning && chat.activeThinking && chat.activeThinking.steps.length > 0 ? (
                <LazyChainOfThought
                  steps={chat.activeThinking.steps}
                  thinking={chat.activeThinking.thinking}
                  durationMs={chat.streamMeta.thinkingDurationMs}
                  isLive
                />
              ) : null}
              {chat.agentRunning ? (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
                  <LazyMessageBubble
                    message={stripWorkspaceRichRendererFallback(streamingMessage)}
                    isLast
                    onRunInTerminal={onRunInTerminal}
                  />
                  <WorkspaceRichChatEvents
                    message={streamingMessage}
                    repoPath={tab.repo?.localPath}
                    onPermissionDecision={chat.handleClaudePermissionDecision}
                  />
                </div>
              ) : null}
              {!chat.agentRunning && chat.isRuntimeBound && chat.supervisorActive && chat.messages.length > 0 && !laneRetired ? (
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
                  <span style={{ fontSize: 11, color: 'var(--t-text-faint)', fontFamily: 'var(--font-sans-system)', fontWeight: 500 }}>
                    Agent working...
                  </span>
                  <style>{'@keyframes o8ThinkPulse { 0%, 80%, 100% { opacity: 0.25; transform: scale(0.8); } 40% { opacity: 1; transform: scale(1.1); } }'}</style>
                </div>
              ) : null}
              {tab.orchestrationPacket && livePacket ? (
                <ChatPacketStatusBanner
                  status={liveStatus}
                  laneId={livePacket.lane?.laneId ?? null}
                  packetTitle={livePacket.title ?? tab.orchestrationPacket.title ?? null}
                  onOpenInActivity={
                    orchestratorData?.onOpenO8Panel
                      ? () => orchestratorData.onOpenO8Panel?.({ tab: 'activity' })
                      : undefined
                  }
                />
              ) : null}
            </div>
          </Suspense>
        )}
      </div>

      {chat.showScrollToBottom && (chat.llmMessages.length > 0 || chat.agentRunning) ? (
        <div
          style={{
            position: 'absolute',
            left: '50%',
            transform: 'translateX(-50%)',
            bottom: 96,
            zIndex: 40,
            animation: 'llmFadeIn 150ms ease-out',
            pointerEvents: 'none',
          }}
        >
          <button
            type="button"
            onClick={() => { chat.scrollToBottom(true); }}
            title="Jump to latest message"
            style={{
              pointerEvents: 'auto',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              height: 26,
              paddingTop: 0,
              paddingBottom: 0,
              paddingLeft: 10,
              paddingRight: 10,
              borderRadius: 999,
              borderWidth: 1,
              borderStyle: 'solid',
              borderColor: 'var(--t-border)',
              background: 'var(--t-panel)',
              color: 'var(--t-text-muted)',
              boxShadow: 'var(--t-panel-shadow)',
              backdropFilter: 'blur(18px) saturate(1.3)',
              WebkitBackdropFilter: 'blur(18px) saturate(1.3)',
              cursor: 'pointer',
              fontSize: 11,
              fontWeight: 500,
              letterSpacing: '0.01em',
              fontFamily: 'var(--font-sans-system)',
              transition: 'background 140ms cubic-bezier(0.22, 1, 0.36, 1), color 140ms cubic-bezier(0.22, 1, 0.36, 1)',
            } as CSSProperties}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'var(--t-bg-card)';
              e.currentTarget.style.color = 'var(--t-text)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'var(--t-panel)';
              e.currentTarget.style.color = 'var(--t-text-muted)';
            }}
          >
            <ArrowDown size={11} />
            <span>Latest</span>
          </button>
        </div>
      ) : null}

      {laneRetired ? (
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
            background: retirement.merged
              ? 'linear-gradient(180deg, rgba(34, 197, 94, 0.06), rgba(34, 197, 94, 0.02))'
              : 'var(--t-panel)',
            color: 'var(--t-text-secondary)',
            fontSize: 12,
            fontWeight: 600,
            letterSpacing: '-0.005em',
          }}
        >
          {retirement.merged ? (
            <CheckCircle2 size={14} style={{ color: retirement.tone, flexShrink: 0 }} />
          ) : (
            <AlertCircle size={14} style={{ color: retirement.tone, flexShrink: 0 }} />
          )}
          <span>{retirement.bannerLabel}</span>
          <span style={{ color: 'var(--t-text-muted)', fontWeight: 500 }}>
            {retirement.bannerSub}
          </span>
        </div>
      ) : null}

      <WorkspaceChatComposer
        chat={chat}
        tab={tab}
        isLaneArchived={laneRetired}
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
