'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { buildLinkedIssueContext } from '@/components/desktop/IssueLinkPicker';
import type { TerminalTab } from '@/components/desktop/workspace-terminal/types';
import { shouldPollPacketTranscript, usePacketTranscriptPoll } from '@/components/desktop/workspace-terminal/use-packet-transcript-poll';
import { useWorkspaceChatModelOptions } from '@/components/desktop/workspace-terminal/useWorkspaceChatModelOptions';
import {
  fetchOwnedRuntimeSteerReceipt,
  ownedRuntimeCanAcceptInput,
  shouldHoldOwnedRuntimeSteer,
} from '@/components/desktop/workspace-terminal/owned-runtime-steer';
import {
  buildClaudePermissionDecisionMessage,
  coerceClaudeCodeChatEvent,
  mergeClaudeCodeChatEvent,
  workspaceUsageTokens,
  type ClaudePermissionDecision,
  type WorkspaceUsageTokens,
  type WorkspaceStreamEvent,
} from '@/components/desktop/workspace-terminal/workspace-stream-events';
import { getRuntimeCapability, runtimeFromSessionKeyId, type OrchestratorRuntime } from '@/lib/orchestrator/runtime-capabilities';
import {
  correlatedActionIsUnsettled,
} from '@/lib/orchestrator/action-receipt';
import {
  buildQueuedContextCard,
  buildWorkspaceThinkingStep,
  isAgentRuntimeTab,
  isOwnedCliRuntimeSession,
  mergeTranscriptEntries,
  normalizeWorkspaceChatSessionKey,
  runtimeTransportSessionId,
  upsertWorkspaceToolCall,
} from '@/components/desktop/workspace-terminal/utils';
import type {
  MobileTranscriptEntry,
  MobileTranscriptSource,
  MobileTranscriptThinkingStep,
  MobileTranscriptToolCall,
} from '@/lib/mobile/types';
import { bootstrapTranscripts } from '@/lib/transcripts/bootstrap';
import { transcriptStore } from '@/lib/transcripts/store';
import { useTranscript } from '@/lib/transcripts/useTranscript';
import { isAbortError } from '@/lib/active-long-lived-request';
import { fetchWithLongLivedBudget } from '@/lib/connection-budget';
import { useActiveLongLivedRequest } from '@/lib/use-active-long-lived-request';
import type { ClaudeCodeStreamJsonChatEvent } from '@/lib/claude-code/stream-json-parser';
import type { PendingSteer } from '@/components/desktop/thoughts/chat-panel/PendingSteerCard';
import { interruptRuntimeSurface } from '@/components/desktop/thoughts/chat-panel/runtimeInterrupt';
import { useSteerAutoFire } from '@/components/desktop/thoughts/chat-panel/useSteerAutoFire';
import { useWorkspaceChatDraftRetention } from '@/components/desktop/workspace-terminal/workspace-chat-drafts';

interface UseWorkspaceChatPaneOptions {
  tab: TerminalTab;
  active?: boolean;
  onUpdateMessages: (tabId: string, messages: MobileTranscriptEntry[]) => void;
  onUpdateSessionKey: (tabId: string, sessionKey: string) => void;
  onSelectModel: (tabId: string, modelId: string) => void;
  onConsumeDraftInjection: (tabId: string, injectionId: string) => void;
}

export function useWorkspaceChatPane({
  tab,
  active = false,
  onUpdateMessages,
  onUpdateSessionKey,
  onSelectModel,
  onConsumeDraftInjection,
}: UseWorkspaceChatPaneOptions) {
  const { draft, setDraft, queuedContextCards, setQueuedContextCards } = useWorkspaceChatDraftRetention(tab.id);
  const [sending, setSending] = useState(false);
  const [agentRunning, setAgentRunning] = useState(false);
  const [liveAssistantId, setLiveAssistantId] = useState<string | null>(null);
  const [streamingText, setStreamingText] = useState('');
  const [activeToolCalls, setActiveToolCalls] = useState<MobileTranscriptToolCall[]>([]);
  const [activeClaudeCodeEvents, setActiveClaudeCodeEvents] = useState<ClaudeCodeStreamJsonChatEvent[]>([]);
  const [activeThinking, setActiveThinking] = useState<{ steps: MobileTranscriptThinkingStep[]; thinking: string } | null>(null);
  const [streamMeta, setStreamMeta] = useState<{
    tokens?: WorkspaceUsageTokens;
    costUsd?: number;
    sources?: MobileTranscriptSource[];
    recalledFacts?: number;
    thinkingDurationMs?: number;
  }>({});
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [issuePickerOpen, setIssuePickerOpen] = useState(false);
  const [claudePlanMode, setClaudePlanMode] = useState(false);
  const [claudeBypassPermissions, setClaudeBypassPermissions] = useState(false);
  const [pendingSteers, setPendingSteers] = useState<PendingSteer[]>([]);
  const [editingSteerId, setEditingSteerId] = useState<string | null>(null);
  const [ownedSessionReady, setOwnedSessionReady] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const composeRef = useRef<HTMLTextAreaElement>(null);
  const liveToolCallsRef = useRef<MobileTranscriptToolCall[]>([]);
  const messagesRef = useRef<MobileTranscriptEntry[]>([]);
  const stickToBottomRef = useRef(true);
  const handledDraftInjectionRef = useRef<string | null>(null);
  const queuedSteerSendNowRef = useRef<(text?: string) => void>(() => {});
  const streamRequest = useActiveLongLivedRequest(active);

  const tabId = tab.id;
  const chatSessionKey = tab.chatSessionKey;
  // The session key is a third source of runtime identity, and often the only
  // one present: four live claude-code lanes showed the composer's Codex
  // default because neither the packet nor the tab carried a runtime, while
  // their `claude-code-owned:*` keys said exactly what was running (#1749).
  const chatRuntime = (
    tab.orchestrationPacket?.runtime
    ?? tab.chatRuntime
    ?? runtimeFromSessionKeyId(chatSessionKey)
    ?? undefined
  ) as OrchestratorRuntime | undefined;
  const linkedIssue = tab.linkedIssue ?? null;
  const normalizedSessionKey = useMemo(
    () => normalizeWorkspaceChatSessionKey(chatRuntime, chatSessionKey),
    [chatRuntime, chatSessionKey],
  );
  const transportSessionId = useMemo(
    () => runtimeTransportSessionId(chatRuntime, chatSessionKey),
    [chatRuntime, chatSessionKey],
  );
  // Naming a runtime we cannot identify is how "Codex working…" ended up over
  // a Claude worker. When no source resolves, say nothing specific.
  const runtimeLabel = useMemo(
    () => (chatRuntime ? getRuntimeCapability(chatRuntime).label : 'Agent'),
    [chatRuntime],
  );
  const { availableModels, selectedModel } = useWorkspaceChatModelOptions(chatRuntime, tab.chatModel);
  const isAgentTab = isAgentRuntimeTab(tab);
  const isRuntimeBound = Boolean(normalizedSessionKey && isAgentTab);
  const isOwnedRuntimeBound = isOwnedCliRuntimeSession(normalizedSessionKey);

  const toggleClaudePlanMode = useCallback(() => {
    setClaudePlanMode((current) => {
      const next = !current;
      if (next) setClaudeBypassPermissions(false);
      return next;
    });
  }, []);

  const enableClaudeBypassPermissions = useCallback(() => {
    setClaudePlanMode(false);
    setClaudeBypassPermissions(true);
  }, []);
  const disableClaudeBypassPermissions = useCallback(() => setClaudeBypassPermissions(false), []);

  // Reads go through the transcript store; writes mirror back via `commitMessages`.
  const transcriptSlice = useTranscript(normalizedSessionKey, { live: active });
  const fallbackMessages = useMemo(() => tab.chatMessages ?? [], [tab.chatMessages]);
  const messages = useMemo(() => {
    if (normalizedSessionKey && transcriptSlice.status !== 'idle') {
      return transcriptSlice.messages;
    }
    return fallbackMessages;
  }, [fallbackMessages, normalizedSessionKey, transcriptSlice]);

  // PacketId-keyed transcript poll for dispatched Codex lanes with an empty sessionKey slice.
  const packetEvents = usePacketTranscriptPoll({
    enabled: isAgentTab && shouldPollPacketTranscript(messages),
    packetIdHint: tab.orchestrationPacket?.packetId ?? null,
    sessionKey: normalizedSessionKey,
    active,
  });
  const commitMessages = useCallback(
    (next: MobileTranscriptEntry[]) => {
      onUpdateMessages(tabId, next);
      if (normalizedSessionKey) {
        transcriptStore.setSlice(normalizedSessionKey, {
          messages: next,
          status: 'fresh',
          lastUpdated: Date.now(),
        });
      }
    },
    [normalizedSessionKey, onUpdateMessages, tabId],
  );

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  const scrollToBottom = useCallback((force = false) => {
    if (!scrollRef.current) return;
    if (!force && !stickToBottomRef.current) return;
    setShowScrollToBottom(false);
    requestAnimationFrame(() => {
      if (scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      }
    });
  }, []);

  const handleScroll = useCallback(() => {
    if (!scrollRef.current) return;
    const el = scrollRef.current;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distFromBottom < 80;
    setShowScrollToBottom(distFromBottom >= 80);
  }, []);

  const supervisorActive = (() => {
    const status = tab.supervisorStatus?.trim().toLowerCase();
    return status === 'running' || status === 'launched' || status === 'waiting';
  })();

  const queuePendingSteer = useCallback((text: string) => {
    const message = text.trim();
    if (!message) return;
    const id = `steer-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    setPendingSteers((previous) => [...previous, { id, text: message }]);
  }, []);

  const refreshOwnedSessionReady = useCallback(async (): Promise<boolean> => {
    if (!isOwnedRuntimeBound || !normalizedSessionKey) {
      setOwnedSessionReady(true);
      return true;
    }
    try {
      const response = await fetch('/api/runtime/inventory?fresh=1', { cache: 'no-store' });
      if (!response.ok) {
        setOwnedSessionReady(false);
        return false;
      }
      const payload = await response.json().catch(() => null) as { agents?: unknown[] } | null;
      const agents = Array.isArray(payload?.agents) ? payload.agents : [];
      const ready = ownedRuntimeCanAcceptInput(agents, normalizedSessionKey);
      setOwnedSessionReady(ready);
      return ready;
    } catch {
      setOwnedSessionReady(false);
      return false;
    }
  }, [isOwnedRuntimeBound, normalizedSessionKey]);

  useEffect(() => {
    if (!isOwnedRuntimeBound || !normalizedSessionKey) {
      setOwnedSessionReady(true);
      return undefined;
    }
    let cancelled = false;
    const refresh = async () => {
      const ready = await refreshOwnedSessionReady();
      if (cancelled) return;
      setOwnedSessionReady(ready);
    };
    void refresh();
    // Poll ONLY while a steer is actually queued. A fresh inventory probe
    // every 2s on every active owned tab is the #1484 saturation class; the
    // send path refreshes readiness inline, and auto-fire only needs the
    // poll while it is holding messages.
    if (pendingSteers.length === 0) return () => { cancelled = true; };
    const interval = window.setInterval(() => { void refresh(); }, 2_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [active, isOwnedRuntimeBound, normalizedSessionKey, pendingSteers.length, refreshOwnedSessionReady]);

  // Seed once on session bind. Visible panes stay current through the shared
  // realtime subscription; reconnect requests a fresh server bootstrap.
  useEffect(() => {
    if (!normalizedSessionKey) return undefined;
    const controller = new AbortController();
    void bootstrapTranscripts([normalizedSessionKey], {
      merge: mergeTranscriptEntries,
      signal: controller.signal,
    });
    return () => {
      controller.abort();
    };
  }, [normalizedSessionKey]);

  const sendText = useCallback(async (inputText: string, options?: {
    baseMessages?: MobileTranscriptEntry[];
    claudeMode?: { planMode: boolean; bypassPermissions: boolean };
  }) => {
    const text = inputText.trim();
    if (!text || sending) return;
    const ownedRuntimeAction = isOwnedRuntimeBound && Boolean(normalizedSessionKey);
    if (ownedRuntimeAction && !(await refreshOwnedSessionReady())) {
      queuePendingSteer(text);
      return;
    }

    stickToBottomRef.current = true;
    setShowScrollToBottom(false);
    setSending(true);
    setAgentRunning(true);
    setStreamingText('');
    liveToolCallsRef.current = [];
    setActiveToolCalls([]);
    setActiveClaudeCodeEvents([]);
    setActiveThinking({
      steps: [{ type: 'thinking', label: 'Reasoning through the problem...', status: 'active' }],
      thinking: '',
    });
    setStreamMeta({});

    const userMsg: MobileTranscriptEntry = {
      id: `msg-${Date.now()}-user`,
      role: 'user',
      text,
      timestamp: Date.now(),
      timestampLabel: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    };
    const baseMessages = options?.baseMessages ?? messagesRef.current;
    const updated = [...baseMessages, userMsg];
    if (!ownedRuntimeAction) {
      commitMessages(updated);
      scrollToBottom(true);
    }

    let streamController: AbortController | null = null;
    let pendingAssistantId: string | null = null;
    let ownedDeliveryAccepted = false;
    let ownedDeliveryUnsettled = false;

    try {
      const composedMessage = [buildLinkedIssueContext(linkedIssue), text].filter(Boolean).join('\n\n');
      let endpoint = '';
      let body: Record<string, unknown> = {};

      if (chatRuntime === 'claude-code') {
        const effectiveClaudePlanMode = options?.claudeMode?.planMode ?? claudePlanMode;
        const effectiveClaudeBypassPermissions = options?.claudeMode?.bypassPermissions ?? claudeBypassPermissions;
        endpoint = '/api/claude-code/send';
        body = {
          message: composedMessage,
          tabId,
          sessionId: transportSessionId,
          cwd: tab.repo?.localPath,
          model: selectedModel?.id,
          resumeSessionId: tab.claudeSessionId,
          planMode: effectiveClaudePlanMode,
          bypassPermissions: effectiveClaudeBypassPermissions,
        };
      } else if (chatRuntime === 'codex' || chatRuntime === 'gemini' || chatRuntime === 'opencode') {
        // Owned CLI sessions (dispatched via the orchestrator) steer through
        // the generic /api/runtime/action verb — the owned-session-store
        // injects the message into the live CLI process. Same pattern for
        // codex, gemini, and opencode since they share the primitive.
        if (normalizedSessionKey && isOwnedCliRuntimeSession(normalizedSessionKey)) {
          const { response: res, payload } = await fetchOwnedRuntimeSteerReceipt(
            normalizedSessionKey,
            composedMessage,
          );
          if (shouldHoldOwnedRuntimeSteer(res.ok, payload)) {
            setOwnedSessionReady(false);
            queuePendingSteer(text);
            return;
          }
          if (!res.ok || payload?.ok === false) {
            throw new Error('owned_runtime_send_failed');
          }
          ownedDeliveryAccepted = true;
          if (normalizedSessionKey) {
            await bootstrapTranscripts([normalizedSessionKey], {
              merge: mergeTranscriptEntries,
              refetchFresh: true,
            });
          }
          return;
        }
        // Non-owned discovered sessions fall back to the codex stream endpoint.
        if (chatRuntime !== 'codex') {
          throw new Error(`Discovered ${chatRuntime} sessions don't support send yet — dispatch a packet via the orchestrator instead.`);
        }
        endpoint = '/api/codex/send';
        body = {
          message: composedMessage,
          threadId: transportSessionId,
          cwd: tab.repo?.localPath,
          model: selectedModel?.id,
        };
      } else {
        throw new Error('Unsupported workspace runtime session.');
      }

      const assistantId = `msg-${Date.now()}-assistant`;
      pendingAssistantId = assistantId;
      let nextTranscript: MobileTranscriptEntry[] = [
        ...updated,
        {
          id: assistantId,
          role: 'assistant',
          text: '',
          timestamp: Date.now(),
          timestampLabel: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          toolCalls: [],
        },
      ];
      setLiveAssistantId(assistantId);
      commitMessages(nextTranscript);

      streamController = streamRequest.begin();
      const res = await fetchWithLongLivedBudget(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: streamController.signal,
      });

      if (!res.ok || !res.body) {
        const errText = await res.text().catch(() => res.statusText);
        commitMessages(
          nextTranscript.map((entry) => entry.id === assistantId ? { ...entry, text: `Error: ${errText || res.statusText}` } : entry),
        );
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let accumulated = '';
      let buffer = '';
      let thinkingText = '';
      let claudeCodeEvents: ClaudeCodeStreamJsonChatEvent[] = [];
      const thinkingSteps: MobileTranscriptThinkingStep[] = [
        { type: 'thinking', label: 'Reasoning through the problem...', status: 'active' },
      ];
      const thinkingStartTime = Date.now();
      let isThinking = true;
      let tokens: WorkspaceUsageTokens | undefined;
      let costUsd: number | undefined;
      let recalledFacts = 0;
      const sources: MobileTranscriptSource[] = [];

      const pushThinkingState = (forceLive = false) => {
        if (thinkingSteps.length === 0 && !thinkingText) {
          setActiveThinking(null);
          return;
        }
        const steps = thinkingSteps.map((step) => ({ ...step }));
        setActiveThinking({
          steps: forceLive ? steps : steps.map((step) => ({ ...step, status: step.status === 'active' ? 'complete' : step.status })),
          thinking: thinkingText,
        });
      };

      const updateAssistantEntry = () => {
        const thinkingDurationMs = (thinkingSteps.length > 0 || thinkingText)
          ? Date.now() - thinkingStartTime
          : undefined;
        const uniqueSources = sources.filter((source, index, current) => (
          current.findIndex((candidate) => (
            candidate.title === source.title
            && candidate.url === source.url
            && candidate.path === source.path
          )) === index
        ));
        setStreamMeta({
          tokens,
          costUsd,
          sources: uniqueSources.length > 0 ? uniqueSources : undefined,
          recalledFacts: recalledFacts > 0 ? recalledFacts : undefined,
          thinkingDurationMs,
        });
        setActiveClaudeCodeEvents(claudeCodeEvents);
        nextTranscript = nextTranscript.map((entry) => (
          entry.id === assistantId
            ? {
                ...entry,
                text: accumulated,
                model: selectedModel.label,
                tokens,
                costUsd,
                sources: uniqueSources.length > 0 ? uniqueSources : undefined,
                recalledFacts: recalledFacts > 0 ? recalledFacts : undefined,
                toolCalls: liveToolCallsRef.current.length > 0 ? [...liveToolCallsRef.current] : undefined,
                thinking: thinkingText || undefined,
                thinkingSteps: thinkingSteps.length > 0
                  ? thinkingSteps.map((step) => ({ ...step, status: step.status === 'active' ? 'complete' : step.status }))
                  : undefined,
                thinkingDurationMs,
                claudeCodeEvents: claudeCodeEvents.length > 0 ? [...claudeCodeEvents] : undefined,
              }
            : entry
        ));
        commitMessages(nextTranscript);
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const event = JSON.parse(line.slice(6)) as WorkspaceStreamEvent;
            const claudeCodeEvent = coerceClaudeCodeChatEvent(event);
            if (claudeCodeEvent) {
              claudeCodeEvents = mergeClaudeCodeChatEvent(claudeCodeEvents, claudeCodeEvent);
              updateAssistantEntry();
            }

            if ((event.type === 'delta' || event.type === 'content') && event.text) {
              if (isThinking) {
                isThinking = false;
                thinkingSteps.forEach((step) => {
                  if (step.status === 'active') {
                    step.status = 'complete';
                  }
                });
                pushThinkingState(true);
              }
              accumulated += event.text;
              setStreamingText(accumulated);
              updateAssistantEntry();
              scrollToBottom(false);
            }

            if (event.type === 'thinking') {
              if (!isThinking) {
                isThinking = true;
                thinkingSteps.push({
                  type: 'thinking',
                  label: 'Reasoning through the problem...',
                  status: 'active',
                });
              }
              if (event.text) {
                thinkingText += event.text;
                const nextLines = event.text.split('\n').filter((candidate) => candidate.trim());
                for (const candidate of nextLines) {
                  const trimmed = candidate.trim();
                  if (
                    trimmed.length > 10
                    && (
                      trimmed.startsWith('I need to')
                      || trimmed.startsWith('Let me')
                      || trimmed.startsWith('First,')
                      || trimmed.startsWith('Now')
                      || trimmed.startsWith('The ')
                      || trimmed.startsWith('This ')
                    )
                  ) {
                    const activeStep = thinkingSteps.find((step) => step.status === 'active');
                    if (activeStep) {
                      activeStep.label = trimmed.slice(0, 60) + (trimmed.length > 60 ? '...' : '');
                    }
                  }
                }
              }
              pushThinkingState(true);
            }

            if ((event.type === 'tool' || event.type === 'tool_call') && event.name) {
              const toolStatus = event.status === 'calling' || event.status === 'running' || event.status === 'done'
                ? event.status
                : 'running';
              const nextTool: MobileTranscriptToolCall = {
                name: event.name,
                status: toolStatus,
                args: event.args,
              };
              const nextTools = upsertWorkspaceToolCall(liveToolCallsRef.current, nextTool);
              liveToolCallsRef.current = nextTools;
              setActiveToolCalls(nextTools);
              const nextStep = buildWorkspaceThinkingStep(nextTool);
              const existingStep = thinkingSteps.find((step) => step.label === nextStep.label);
              if (existingStep) {
                existingStep.status = nextStep.status;
                existingStep.detail = nextStep.detail;
              } else {
                thinkingSteps.push(nextStep);
              }
              pushThinkingState(true);
              updateAssistantEntry();
            }

            if (event.type === 'tool_result') {
              const lastTool = event.name
                ? liveToolCallsRef.current.find((tool) => tool.name === event.name)
                : liveToolCallsRef.current[liveToolCallsRef.current.length - 1];
              if (lastTool) {
                const nextTools = upsertWorkspaceToolCall(liveToolCallsRef.current, {
                  ...lastTool,
                  status: 'done',
                  preview: event.preview ?? lastTool.preview,
                  result: event.output ?? lastTool.result,
                });
                liveToolCallsRef.current = nextTools;
                setActiveToolCalls(nextTools);
              }
              const toolStep = [...thinkingSteps].reverse().find((step) => step.status === 'active' && step.type !== 'thinking');
              if (toolStep) toolStep.status = 'complete';
              pushThinkingState(true);
              updateAssistantEntry();
            }

            if (event.type === 'usage') {
              tokens = workspaceUsageTokens(event, tokens);
              if (typeof event.costUsd === 'number') {
                costUsd = event.costUsd;
              }
              updateAssistantEntry();
            }

            if (event.type === 'memory_recall') {
              recalledFacts = event.factCount ?? 0;
              if (recalledFacts > 0) {
                thinkingSteps.push({
                  type: 'search',
                  label: `Recalled ${recalledFacts} memor${recalledFacts === 1 ? 'y' : 'ies'} from Cortex`,
                  status: 'complete',
                });
                pushThinkingState(true);
                updateAssistantEntry();
              }
            }

            if (event.type === 'sources' && Array.isArray(event.sources)) {
              sources.splice(0, sources.length, ...event.sources);
              updateAssistantEntry();
            }

            if (event.sessionId && chatRuntime === 'claude-code') {
              onUpdateSessionKey(tabId, event.sessionId);
            }
            if (event.threadId && chatRuntime === 'codex') {
              onUpdateSessionKey(tabId, event.threadId);
            }

            if (event.type === 'done' || event.type === 'close') {
              if (typeof event.inputTokens === 'number' || typeof event.outputTokens === 'number') {
                tokens = workspaceUsageTokens(event, tokens);
              }
              if (typeof event.costUsd === 'number') {
                costUsd = event.costUsd;
              }
              if (event.text && !accumulated) {
                accumulated = event.text;
                setStreamingText(accumulated);
              }
              const settledTools = liveToolCallsRef.current.map((tool) => ({ ...tool, status: 'done' as const }));
              if (settledTools.length > 0) {
                liveToolCallsRef.current = settledTools;
                setActiveToolCalls(settledTools);
              }
              thinkingSteps.forEach((step) => {
                if (step.status === 'active') {
                  step.status = 'complete';
                }
              });
              pushThinkingState(false);
              updateAssistantEntry();
            }

            if (event.type === 'error' && event.text) {
              accumulated += `\nWarning: ${event.text}`;
              updateAssistantEntry();
            }
          } catch {
            return;
          }
        }
      }

      if (!accumulated) {
        commitMessages(
          nextTranscript.map((entry) => entry.id === assistantId ? { ...entry, text: 'No response received' } : entry),
        );
      }
    } catch (err) {
      if (streamController?.signal.aborted || isAbortError(err)) {
        if (pendingAssistantId) {
          commitMessages(messagesRef.current.map((entry) => (
            entry.id === pendingAssistantId && !entry.text.trim()
              ? { ...entry, text: 'Stream paused because this tab became inactive. Reopen it to refresh the transcript.' }
              : entry
          )));
        }
        return;
      }
      if (ownedRuntimeAction && correlatedActionIsUnsettled(err)) {
        ownedDeliveryUnsettled = true;
        commitMessages([
          ...baseMessages,
          {
            id: `msg-${Date.now()}-pending`,
            role: 'assistant',
            text: err.message,
            timestamp: Date.now(),
            timestampLabel: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          },
        ]);
        return;
      }
      if (ownedRuntimeAction) {
        setDraft((current) => current.trim() ? current : text);
        commitMessages([
          ...baseMessages,
          {
            id: `msg-${Date.now()}-error`,
            role: 'assistant',
            text: `${runtimeLabel} couldn't accept that message. It has been restored to the composer.`,
            timestamp: Date.now(),
            timestampLabel: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          },
        ]);
        return;
      }
      commitMessages([
        ...updated,
        {
          id: `msg-${Date.now()}-error`,
          role: 'assistant',
          text: `Error: ${err instanceof Error ? err.message : 'Failed to send'}`,
          timestamp: Date.now(),
          timestampLabel: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        },
      ]);
    } finally {
      if (streamController) streamRequest.finish(streamController);
      if (!ownedDeliveryUnsettled) setSending(false);
      setAgentRunning(false);
      setLiveAssistantId(null);
      setStreamingText('');
      setActiveThinking(null);
      setActiveClaudeCodeEvents([]);
      setStreamMeta({});
      if (normalizedSessionKey && (!ownedRuntimeAction || ownedDeliveryAccepted)) {
        transcriptStore.setStatus(normalizedSessionKey, 'loading');
      }
    }
  }, [chatRuntime, claudeBypassPermissions, claudePlanMode, commitMessages, isOwnedRuntimeBound, linkedIssue, normalizedSessionKey, onUpdateSessionKey, queuePendingSteer, refreshOwnedSessionReady, runtimeLabel, scrollToBottom, selectedModel, sending, setDraft, streamRequest, tab.claudeSessionId, tab.repo?.localPath, tabId, transportSessionId]);

  queuedSteerSendNowRef.current = (text?: string) => {
    if (text?.trim()) void sendText(text);
  };
  useSteerAutoFire({
    displayWaiting: sending || (isOwnedRuntimeBound && !ownedSessionReady),
    isOrchestratorMode: false,
    pendingSteers,
    editingSteerId,
    setPendingSteers,
    sendNowRef: queuedSteerSendNowRef,
  });

  const handleSteerNow = useCallback((id: string) => {
    setPendingSteers((previous) => {
      const index = previous.findIndex((steer) => steer.id === id);
      if (index <= 0) return previous;
      const target = previous[index];
      return [target, ...previous.slice(0, index), ...previous.slice(index + 1)];
    });
    if (!normalizedSessionKey) return;
    setOwnedSessionReady(false);
    void interruptRuntimeSurface(normalizedSessionKey)
      .finally(() => { void refreshOwnedSessionReady(); });
  }, [normalizedSessionKey, refreshOwnedSessionReady]);

  const handleDeleteSteer = useCallback((id: string) => {
    setPendingSteers((previous) => previous.filter((steer) => steer.id !== id));
    setEditingSteerId((current) => current === id ? null : current);
  }, []);

  const handleEditSteer = useCallback((id: string, text: string) => {
    const next = text.trim();
    if (!next) {
      setPendingSteers((previous) => previous.filter((steer) => steer.id !== id));
      return;
    }
    setPendingSteers((previous) => previous.map((steer) => (
      steer.id === id ? { ...steer, text: next } : steer
    )));
  }, []);

  const handleSend = useCallback(async () => {
    const baseDraft = draft.trim();
    if ((!baseDraft && queuedContextCards.length === 0) || sending) return;
    const text = [
      ...queuedContextCards.map((card) => card.text.trim()).filter(Boolean),
      baseDraft,
    ].filter(Boolean).join('\n\n');
    setQueuedContextCards([]);
    setDraft('');
    await sendText(text);
  }, [draft, queuedContextCards, sendText, sending, setDraft, setQueuedContextCards]);

  useEffect(() => {
    const injection = tab.chatDraftInjection;
    if (!injection?.id) return;
    if (handledDraftInjectionRef.current === injection.id) return;
    handledDraftInjectionRef.current = injection.id;
    stickToBottomRef.current = true;

    if (injection.autoSend) {
      setDraft('');
      void sendText(injection.text);
      requestAnimationFrame(() => composeRef.current?.focus());
    } else {
      setQueuedContextCards((previous) => {
        if (previous.some((card) => card.id === injection.id)) return previous;
        return [...previous, buildQueuedContextCard(injection)];
      });
      requestAnimationFrame(() => composeRef.current?.focus());
    }

    onConsumeDraftInjection(tabId, injection.id);
  }, [onConsumeDraftInjection, sendText, setDraft, setQueuedContextCards, tab.chatDraftInjection, tabId]);

  const handleClaudePermissionDecision = useCallback(async (
    request: Extract<ClaudeCodeStreamJsonChatEvent, { type: 'permission_request' }>,
    decision: ClaudePermissionDecision,
  ) => {
    const message = buildClaudePermissionDecisionMessage(request, decision);
    if (sending) {
      setDraft(message);
      throw new Error('Current Claude turn is still streaming; decision loaded into the composer.');
    }
    const claudeMode = decision === 'approve'
      ? { planMode: false, bypassPermissions: true }
      : { planMode: true, bypassPermissions: false };
    setClaudePlanMode(claudeMode.planMode);
    setClaudeBypassPermissions(claudeMode.bypassPermissions);
    await sendText(message, { claudeMode });
  }, [sendText, sending, setDraft]);

  const visibleTranscriptEntries = useMemo(
    () => (agentRunning && liveAssistantId ? messages.filter((message) => message.id !== liveAssistantId) : messages),
    [agentRunning, liveAssistantId, messages],
  );

  useEffect(() => {
    if (!scrollRef.current) return;
    if (visibleTranscriptEntries.length === 0 && !streamingText && activeToolCalls.length === 0) return;
    scrollToBottom();
  }, [activeToolCalls.length, scrollToBottom, streamingText, visibleTranscriptEntries.length]);

  const handleRemoveQueuedContext = useCallback((contextId: string) => {
    setQueuedContextCards((previous) => previous.filter((card) => card.id !== contextId));
  }, [setQueuedContextCards]);

  return {
    activeToolCalls,
    activeClaudeCodeEvents,
    activeThinking,
    agentRunning,
    availableModels,
    canSend: draft.trim().length > 0 || queuedContextCards.length > 0,
    chatRuntime,
    claudeBypassPermissions,
    claudePlanMode,
    composeRef,
    disableClaudeBypassPermissions,
    draft,
    enableClaudeBypassPermissions,
    handleRemoveQueuedContext,
    handleDeleteSteer,
    handleEditSteer,
    handleSteerNow,
    handleClaudePermissionDecision,
    handleScroll,
    handleSend,
    sendText,
    isAgentTab,
    isRuntimeBound,
    issuePickerOpen,
    linkedIssue,
    messages,
    packetTranscriptEntries: packetEvents.entries,
    packetTranscriptActivity: packetEvents.activity,
    normalizedSessionKey,
    onEditingSteerChange: setEditingSteerId,
    pendingSteers,
    queuedContextCards,
    runtimeLabel,
    scrollRef,
    scrollToBottom,
    selectedModel,
    sending,
    setDraft,
    setIssuePickerOpen,
    showScrollToBottom,
    streamMeta,
    streamingText,
    supervisorActive,
    tabId,
    toggleClaudePlanMode,
    visibleTranscriptEntries,
    onSelectModel,
  };
}
