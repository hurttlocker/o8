'use client';

import { memo, useEffect, useMemo, useState, type CSSProperties } from 'react';
import {
  AlertCircle,
  ArrowDown,
  CheckCircle2,
  MessageSquare,
} from '../lucide-shims';
import { useSharedDesktopWs } from '@/components/desktop/hooks/DesktopWebSocketContext';
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
import { useWorkspaceChatLifecycle } from '@/components/desktop/workspace-terminal/useWorkspaceChatLifecycle';
import { WorkspaceChatComposer } from '@/components/desktop/workspace-terminal/WorkspaceChatComposer';
import { ChatPacketStatusBanner } from '@/components/desktop/workspace-terminal/ChatPacketStatusBanner';
import { ChatPacketReviewDiff } from '@/components/desktop/workspace-terminal/ChatPacketReviewDiff';
import { PacketWorkingFooter } from '@/components/desktop/workspace-terminal/PacketWorkingFooter';
import {
  WorkspaceTranscript,
  type WorkspaceTranscriptHeader,
} from '@/components/desktop/workspace-terminal/WorkspaceTranscript';
import { PromptGlyph } from '@/components/desktop/workspace-terminal/workspace-chat-prompt';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';

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

  const { orchestratorData, livePacket, liveStatus, laneRetired, retirement } = useWorkspaceChatLifecycle({
    tab,
    normalizedSessionKey: chat.normalizedSessionKey,
    runtimeLabel: chat.runtimeLabel,
  });

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

  const streamingEntry = useMemo<MobileTranscriptEntry>(() => ({
    id: `stream:${chat.tabId}`,
    role: 'assistant',
    text: chat.streamingText,
    model: chat.selectedModel.label,
    timestamp: streamingTimestamp ?? 0,
    tokens: chat.streamMeta.tokens,
    costUsd: chat.streamMeta.costUsd,
    sources: chat.streamMeta.sources,
    recalledFacts: chat.streamMeta.recalledFacts,
    claudeCodeEvents: chat.activeClaudeCodeEvents,
    toolCalls: chat.activeToolCalls,
    thinking: chat.activeThinking?.thinking,
    thinkingSteps: chat.activeThinking?.steps,
    thinkingDurationMs: chat.streamMeta.thinkingDurationMs,
    thinkingActive: Boolean(chat.activeThinking),
  }), [chat.tabId, chat.streamingText, chat.selectedModel.label, streamingTimestamp, chat.streamMeta, chat.activeClaudeCodeEvents, chat.activeToolCalls, chat.activeThinking]);

  const packetHeader = useMemo<WorkspaceTranscriptHeader>(() => ({
    enabled: Boolean(tab.orchestrationPacket),
    title: tab.orchestrationPacket?.title ?? tab.label ?? 'Dispatched packet',
    branch: tab.orchestrationPacket?.branchTarget ?? null,
    runtime: tab.orchestrationPacket?.runtime ?? tab.chatRuntime ?? null,
    status: liveStatus,
  }), [liveStatus, tab.chatRuntime, tab.label, tab.orchestrationPacket]);
  const transcriptRepoPath = livePacket?.lane?.worktreePath
    ?? livePacket?.lane?.repoPath
    ?? tab.repo?.localPath;
  const streamingEntries = useMemo(() => [streamingEntry], [streamingEntry]);

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
          paddingTop: chat.messages.length === 0 && !chat.agentRunning ? 0 : 24,
          paddingBottom: 24,
          paddingLeft: 'var(--cortex-chat-gutter)',
          paddingRight: 'var(--cortex-chat-gutter)',
          background: 'transparent',
        }}
      >
        {chat.visibleTranscriptEntries.length === 0 && !chat.agentRunning ? (
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
                const stillWorking = liveStatus === 'running'
                  || liveStatus === 'recovering'
                  || liveStatus === 'launching'
                  || liveStatus === 'queued';
                // #1293 FIX 1 — a dispatched Codex `exec --json` streams its
                // transcript to the LANE, not this session's sessionKey slice.
                // The additive packetId-keyed poll (useWorkspaceChatPane) fills
                // `packetTranscriptEntries`; when present, render the real work instead
                // of a static placeholder. Stays empty for Claude-Code / steered
                // Codex (sessionKey slice fills), so their path is untouched.
                const hasPacketTranscript = chat.packetTranscriptEntries.length > 0;

                // Review affordances shared by the hero + transcript layouts:
                // the inline diff (FIX 2 — so "Ready for review" shows WHAT to
                // review) and the status banner (merge / PR / request-changes).
                // #decision-banner (Q ruling 2026-07-11) — the banner self-fetches
                // the packet's durable review-state, so it renders for parked,
                // rejected, and DETACHED packets (whose livePacket is gone from
                // mission state), not only the narrow live-status set. Feed it a
                // packetId from whatever survives (livePacket → tab) and let the
                // banner return null when there's nothing to decide. This is what
                // gives a rejected packet the same gorgeous card the merged one gets.
                const bannerPacketId = livePacket?.id ?? tab.orchestrationPacket?.packetId ?? null;
                // A detached packet has no client packetId — fall back to the lane
                // sessionKey, which review-state resolves to the real packet.
                const bannerIdentity = bannerPacketId ?? tabSessionKey;
                const reviewAffordances = (
                  <>
                    {awaitingReview && livePacket ? (
                      <ChatPacketReviewDiff packet={livePacket} />
                    ) : null}
                    {bannerIdentity ? (
                      <div style={{ width: '100%', maxWidth: 440 }}>
                        <ChatPacketStatusBanner
                          status={liveStatus}
                          laneId={livePacket?.lane?.laneId ?? null}
                          packetId={bannerPacketId}
                          sessionKey={tabSessionKey}
                          packetTitle={livePacket?.title ?? tab.orchestrationPacket?.title ?? null}
                          mergeMode={livePacket?.lane?.mergeMode ?? null}
                          mergeModeNote={livePacket?.lane?.mergeModeNote ?? null}
                          onReview={
                            orchestratorData?.onOpenO8Panel
                              ? () => orchestratorData.onOpenO8Panel?.({ tab: 'review' })
                              : undefined
                          }
                        />
                      </div>
                    ) : !bannerIdentity && orchestratorData?.onOpenO8Panel ? (
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
                  </>
                );

                if (hasPacketTranscript) {
                  return (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%', maxWidth: 'var(--cortex-chat-column-max)', marginLeft: 'auto', marginRight: 'auto' }}>
                      <WorkspaceTranscript
                        entries={chat.packetTranscriptEntries}
                        packetHeader={packetHeader}
                        repoPath={transcriptRepoPath}
                        onRunInTerminal={onRunInTerminal}
                        onPermissionDecision={chat.handleClaudePermissionDecision}
                      />
                      {stillWorking && !awaitingReview ? (
                        <PacketWorkingFooter
                          status={liveStatus}
                          runtimeLabel={chat.runtimeLabel}
                          activity={chat.packetTranscriptActivity}
                          fallbackStartedAt={livePacket?.lane?.lastEventAt ?? livePacket?.lastEventAt ?? null}
                        />
                      ) : null}
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'flex-start', paddingTop: 4 }}>
                        {reviewAffordances}
                      </div>
                    </div>
                  );
                }

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
                        background: awaitingReview ? 'var(--t-warning-soft)' : 'var(--t-accent-soft)',
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
                      {awaitingReview ? 'Ready for review' : `${chat.runtimeLabel} working…`}
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
                    {reviewAffordances}
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
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%', maxWidth: 'var(--cortex-chat-column-max)', marginLeft: 'auto', marginRight: 'auto' }}>
            <WorkspaceTranscript
              entries={chat.visibleTranscriptEntries}
              packetHeader={packetHeader}
              repoPath={transcriptRepoPath}
              markLast={!chat.sending}
              onRunInTerminal={onRunInTerminal}
              onPermissionDecision={chat.handleClaudePermissionDecision}
            />
            {chat.agentRunning ? (
              <WorkspaceTranscript
                entries={streamingEntries}
                repoPath={transcriptRepoPath}
                isStreaming
                onRunInTerminal={onRunInTerminal}
                onPermissionDecision={chat.handleClaudePermissionDecision}
              />
            ) : null}
            {!chat.agentRunning && chat.isRuntimeBound && chat.supervisorActive && chat.messages.length > 0 && !laneRetired ? (
              <PacketWorkingFooter
                status={liveStatus}
                runtimeLabel={chat.runtimeLabel}
                activity={chat.packetTranscriptActivity}
                fallbackStartedAt={livePacket?.lane?.lastEventAt ?? livePacket?.lastEventAt ?? null}
              />
            ) : null}
            {(livePacket?.id ?? tab.orchestrationPacket?.packetId ?? tabSessionKey) ? (
              <ChatPacketStatusBanner
                status={liveStatus}
                laneId={livePacket?.lane?.laneId ?? null}
                packetId={livePacket?.id ?? tab.orchestrationPacket?.packetId ?? null}
                sessionKey={tabSessionKey}
                packetTitle={livePacket?.title ?? tab.orchestrationPacket?.title ?? null}
                mergeMode={livePacket?.lane?.mergeMode ?? null}
                mergeModeNote={livePacket?.lane?.mergeModeNote ?? null}
                onReview={
                  orchestratorData?.onOpenO8Panel
                    ? () => orchestratorData.onOpenO8Panel?.({ tab: 'review' })
                    : undefined
                }
              />
            ) : null}
          </div>
        )}
      </div>

      {chat.showScrollToBottom && (chat.messages.length > 0 || chat.agentRunning) ? (
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
