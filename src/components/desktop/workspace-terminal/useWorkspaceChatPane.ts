'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { buildLinkedIssueContext } from '@/components/desktop/IssueLinkPicker';
import type { TerminalTab } from '@/components/desktop/workspace-terminal/types';
import { usePacketTranscriptPoll } from '@/components/desktop/workspace-terminal/use-packet-transcript-poll';
import { useWorkspaceChatModelOptions } from '@/components/desktop/workspace-terminal/useWorkspaceChatModelOptions';
import {
  buildClaudePermissionDecisionMessage,
  coerceClaudeCodeChatEvent,
  mergeClaudeCodeChatEvent,
  type ClaudePermissionDecision,
  type WorkspaceStreamEvent,
} from '@/components/desktop/workspace-terminal/workspace-stream-events';
import { getRuntimeCapability } from '@/lib/orchestrator/runtime-capabilities';
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
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [agentRunning, setAgentRunning] = useState(false);
  const [queuedContextCards, setQueuedContextCards] = useState<ReturnType<typeof buildQueuedContextCard>[]>([]);
  const [liveAssistantId, setLiveAssistantId] = useState<string | null>(null);
  const [streamingText, setStreamingText] = useState('');
  const [activeToolCalls, setActiveToolCalls] = useState<MobileTranscriptToolCall[]>([]);
  const [activeClaudeCodeEvents, setActiveClaudeCodeEvents] = useState<ClaudeCodeStreamJsonChatEvent[]>([]);
  const [activeThinking, setActiveThinking] = useState<{ steps: MobileTranscriptThinkingStep[]; thinking: string } | null>(null);
  const [streamMeta, setStreamMeta] = useState<{
    tokens?: { input: number; output: number };
    costUsd?: number;
    sources?: MobileTranscriptSource[];
    recalledFacts?: number;
    thinkingDurationMs?: number;
  }>({});
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [issuePickerOpen, setIssuePickerOpen] = useState(false);
  const [claudePlanMode, setClaudePlanMode] = useState(false);
  const [claudeBypassPermissions, setClaudeBypassPermissions] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const composeRef = useRef<HTMLTextAreaElement>(null);
  const liveToolCallsRef = useRef<MobileTranscriptToolCall[]>([]);
  const messagesRef = useRef<MobileTranscriptEntry[]>([]);
  const stickToBottomRef = useRef(true);
  const handledDraftInjectionRef = useRef<string | null>(null);
  const streamRequest = useActiveLongLivedRequest(active);

  const tabId = tab.id;
  const chatRuntime = (
    tab.orchestrationPacket?.runtime
    ?? tab.chatRuntime
  ) as 'codex' | 'claude-code' | 'gemini' | 'opencode' | 'pi' | undefined;
  const chatSessionKey = tab.chatSessionKey;
  const linkedIssue = tab.linkedIssue ?? null;
  const normalizedSessionKey = useMemo(
    () => normalizeWorkspaceChatSessionKey(chatRuntime, chatSessionKey),
    [chatRuntime, chatSessionKey],
  );
  const transportSessionId = useMemo(
    () => runtimeTransportSessionId(chatRuntime, chatSessionKey),
    [chatRuntime, chatSessionKey],
  );
  const runtimeLabel = useMemo(
    () => getRuntimeCapability(chatRuntime ?? 'codex').label,
    [chatRuntime],
  );
  const { availableModels, selectedModel } = useWorkspaceChatModelOptions(chatRuntime, tab.chatModel);
  const isAgentTab = isAgentRuntimeTab(tab);
  const isRuntimeBound = Boolean(normalizedSessionKey && isAgentTab);

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
  const transcriptSlice = useTranscript(normalizedSessionKey);
  const fallbackMessages = useMemo(() => tab.chatMessages ?? [], [tab.chatMessages]);
  const messages = useMemo(() => {
    if (normalizedSessionKey && transcriptSlice.status !== 'idle') {
      return transcriptSlice.messages;
    }
    return fallbackMessages;
  }, [fallbackMessages, normalizedSessionKey, transcriptSlice]);

  // PacketId-keyed transcript poll for dispatched Codex lanes with an empty sessionKey slice.
  const packetEvents = usePacketTranscriptPoll({
    enabled: isAgentTab && messages.length === 0,
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

  // Load on mount, re-load on activation, and poll only while this tab is active
  // and the supervisor is running. Hidden tabs must not hold transcript polls.
  useEffect(() => {
    if (!normalizedSessionKey) return undefined;
    const controller = new AbortController();
    const run = (refetchFresh = false) => bootstrapTranscripts([normalizedSessionKey], {
      merge: mergeTranscriptEntries,
      signal: controller.signal,
      refetchFresh,
    });
    void run();
    let interval: number | undefined;
    if (active && supervisorActive) {
      interval = window.setInterval(() => { void run(true); }, 3000);
    }
    return () => {
      controller.abort();
      if (interval !== undefined) window.clearInterval(interval);
    };
  }, [normalizedSessionKey, active, supervisorActive]);

  const sendText = useCallback(async (inputText: string, options?: {
    baseMessages?: MobileTranscriptEntry[];
    claudeMode?: { planMode: boolean; bypassPermissions: boolean };
  }) => {
    const text = inputText.trim();
    if (!text || sending) return;

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
    commitMessages(updated);
    scrollToBottom(true);

    let streamController: AbortController | null = null;
    let pendingAssistantId: string | null = null;

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
        if (isOwnedCliRuntimeSession(normalizedSessionKey)) {
          const res = await fetch('/api/runtime/action', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: 'steer',
              surfaceId: normalizedSessionKey,
              message: composedMessage,
            }),
          });
          const payload = await res.json().catch(() => null) as { ok?: boolean; note?: string; error?: string } | null;
          if (!res.ok || payload?.ok === false) {
            const errorText = payload?.error ?? payload?.note ?? res.statusText;
            commitMessages([
              ...updated,
              {
                id: `msg-${Date.now()}-error`,
                role: 'assistant',
                text: `Error: ${errorText || 'Failed to send'}`,
                timestamp: Date.now(),
                timestampLabel: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
              },
            ]);
            return;
          }
          if (normalizedSessionKey) {
            transcriptStore.setStatus(normalizedSessionKey, 'loading');
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
      let tokens: { input: number; output: number } | undefined;
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
              tokens = typeof event.inputTokens === 'number' || typeof event.outputTokens === 'number'
                ? { input: event.inputTokens ?? 0, output: event.outputTokens ?? 0 }
                : tokens;
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
                tokens = {
                  input: event.inputTokens ?? tokens?.input ?? 0,
                  output: event.outputTokens ?? tokens?.output ?? 0,
                };
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
      setSending(false);
      setAgentRunning(false);
      setLiveAssistantId(null);
      setStreamingText('');
      setActiveThinking(null);
      setActiveClaudeCodeEvents([]);
      setStreamMeta({});
      if (normalizedSessionKey) {
        transcriptStore.setStatus(normalizedSessionKey, 'loading');
      }
    }
  }, [chatRuntime, claudeBypassPermissions, claudePlanMode, commitMessages, linkedIssue, normalizedSessionKey, onUpdateSessionKey, scrollToBottom, selectedModel, sending, streamRequest, tab.claudeSessionId, tab.repo?.localPath, tabId, transportSessionId]);

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
  }, [draft, queuedContextCards, sendText, sending]);

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
  }, [onConsumeDraftInjection, sendText, tab.chatDraftInjection, tabId]);

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
  }, [sendText, sending]);

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
  }, []);

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
