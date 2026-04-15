'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { buildLinkedIssueContext } from '@/components/desktop/IssueLinkPicker';
import {
  CLAUDE_CLI_MODELS,
  CODEX_CLI_MODELS,
  getOpenCodeModels,
} from '@/components/desktop/workspace-terminal/constants';
import type {
  TerminalTab,
  WorkspaceCliModelOption,
  WorkspaceLlmMessage,
} from '@/components/desktop/workspace-terminal/types';
import { getCachedOpenCodeProviders, loadOpenCodeProviders } from '@/lib/setup/detection-cache';
import {
  buildQueuedContextCard,
  buildWorkspaceThinkingStep,
  isAgentRuntimeTab,
  isOwnedCodexRuntimeSession,
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

interface UseWorkspaceChatPaneOptions {
  tab: TerminalTab;
  active: boolean;
  onUpdateMessages: (tabId: string, messages: MobileTranscriptEntry[]) => void;
  onUpdateSessionKey: (tabId: string, sessionKey: string) => void;
  onSelectModel: (tabId: string, modelId: string) => void;
  onConsumeDraftInjection: (tabId: string, injectionId: string) => void;
}

export function useWorkspaceChatPane({
  tab,
  active,
  onUpdateMessages,
  onUpdateSessionKey,
  onSelectModel,
  onConsumeDraftInjection,
}: UseWorkspaceChatPaneOptions) {
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [agentRunning, setAgentRunning] = useState(false);
  const [openCodeProviders, setOpenCodeProviders] = useState<string[]>(() => getCachedOpenCodeProviders());
  const [queuedContextCards, setQueuedContextCards] = useState<ReturnType<typeof buildQueuedContextCard>[]>([]);
  const [liveAssistantId, setLiveAssistantId] = useState<string | null>(null);
  const [streamingText, setStreamingText] = useState('');
  const [activeToolCalls, setActiveToolCalls] = useState<MobileTranscriptToolCall[]>([]);
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

  const scrollRef = useRef<HTMLDivElement>(null);
  const composeRef = useRef<HTMLTextAreaElement>(null);
  const liveToolCallsRef = useRef<MobileTranscriptToolCall[]>([]);
  const messagesRef = useRef<MobileTranscriptEntry[]>([]);
  const stickToBottomRef = useRef(true);
  const handledDraftInjectionRef = useRef<string | null>(null);
  const openCodeProvidersLoadedRef = useRef(openCodeProviders.length > 0);

  const messages = useMemo(() => tab.chatMessages ?? [], [tab.chatMessages]);
  const tabId = tab.id;
  const chatRuntime = tab.chatRuntime as 'codex' | 'claude-code' | 'opencode' | undefined;
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
    () => ({ codex: 'Codex', 'claude-code': 'Claude Code', opencode: 'OpenCode' } as const)[chatRuntime ?? 'codex'],
    [chatRuntime],
  );
  const availableModels = useMemo<WorkspaceCliModelOption[]>(
    () => {
      if (chatRuntime === 'claude-code') return CLAUDE_CLI_MODELS;
      if (chatRuntime === 'opencode') return getOpenCodeModels(openCodeProviders);
      return CODEX_CLI_MODELS;
    },
    [chatRuntime, openCodeProviders],
  );
  const selectedModel = useMemo(
    () => availableModels.find((model) => model.id === tab.chatModel) ?? availableModels[0],
    [availableModels, tab.chatModel],
  );
  const isAgentTab = isAgentRuntimeTab(tab);
  const isRuntimeBound = Boolean(normalizedSessionKey && isAgentTab);

  useEffect(() => {
    if (chatRuntime !== 'opencode' || openCodeProvidersLoadedRef.current) return;
    openCodeProvidersLoadedRef.current = true;
    let cancelled = false;
    void loadOpenCodeProviders().then((providers) => {
      if (!cancelled) setOpenCodeProviders(providers);
    });
    return () => {
      cancelled = true;
    };
  }, [chatRuntime]);

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

  const fetchTranscript = useCallback(async () => {
    if (!chatRuntime || !normalizedSessionKey) return;
    if (chatRuntime !== 'codex' && chatRuntime !== 'claude-code') return;
    try {
      const endpoint = `/api/mobile/history?sessionKey=${encodeURIComponent(normalizedSessionKey)}&limit=80`;
      const res = await fetch(endpoint);
      if (!res.ok) return;
      const data = await res.json() as { transcript?: MobileTranscriptEntry[] };
      if (Array.isArray(data.transcript)) {
        onUpdateMessages(tabId, mergeTranscriptEntries(messagesRef.current, data.transcript));
        requestAnimationFrame(() => scrollToBottom(true));
      }
    } catch {
      return;
    }
  }, [chatRuntime, normalizedSessionKey, onUpdateMessages, scrollToBottom, tabId]);

  useEffect(() => {
    if (active) {
      void fetchTranscript();
    }
  }, [active, fetchTranscript]);

  const supervisorActive = (() => {
    const status = tab.supervisorStatus?.trim().toLowerCase();
    return status === 'running' || status === 'launched' || status === 'waiting';
  })();
  const transcriptPollMs = isAgentRuntimeTab(tab) && supervisorActive ? 2_000 : 5_000;

  useEffect(() => {
    if (!active || !normalizedSessionKey) return undefined;
    const id = setInterval(() => {
      void fetchTranscript();
    }, transcriptPollMs);
    return () => clearInterval(id);
  }, [active, fetchTranscript, normalizedSessionKey, transcriptPollMs]);

  useEffect(() => {
    if (!active || !isRuntimeBound) return undefined;
    if (messagesRef.current.length > 0) return undefined;

    const id = setInterval(() => {
      if (messagesRef.current.length > 0) {
        clearInterval(id);
        return;
      }
      void fetchTranscript();
    }, 1_500);
    const timeout = setTimeout(() => clearInterval(id), 60_000);
    return () => {
      clearInterval(id);
      clearTimeout(timeout);
    };
  }, [active, fetchTranscript, isRuntimeBound]);

  const sendText = useCallback(async (inputText: string, options?: { baseMessages?: MobileTranscriptEntry[] }) => {
    const text = inputText.trim();
    if (!text || sending) return;

    stickToBottomRef.current = true;
    setShowScrollToBottom(false);
    setSending(true);
    setAgentRunning(true);
    setStreamingText('');
    liveToolCallsRef.current = [];
    setActiveToolCalls([]);
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
    onUpdateMessages(tabId, updated);
    scrollToBottom(true);

    try {
      const composedMessage = [buildLinkedIssueContext(linkedIssue), text].filter(Boolean).join('\n\n');
      let endpoint = '';
      let body: Record<string, unknown> = {};

      if (chatRuntime === 'claude-code') {
        endpoint = '/api/claude-code/send';
        body = {
          message: composedMessage,
          sessionId: transportSessionId,
          cwd: tab.repo?.localPath,
          model: selectedModel?.id,
          continueLatest: tab.chatContinueLatest !== false,
        };
      } else if (chatRuntime === 'codex') {
        if (isOwnedCodexRuntimeSession(normalizedSessionKey)) {
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
            onUpdateMessages(tabId, [
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
          window.setTimeout(() => {
            void fetchTranscript();
          }, 800);
          return;
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
      onUpdateMessages(tabId, nextTranscript);

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok || !res.body) {
        const errText = await res.text().catch(() => res.statusText);
        onUpdateMessages(
          tabId,
          nextTranscript.map((entry) => entry.id === assistantId ? { ...entry, text: `Error: ${errText || res.statusText}` } : entry),
        );
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let accumulated = '';
      let buffer = '';
      let thinkingText = '';
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
              }
            : entry
        ));
        onUpdateMessages(tabId, nextTranscript);
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
            const event = JSON.parse(line.slice(6)) as {
              type: string;
              text?: string;
              name?: string;
              status?: 'calling' | 'running' | 'done';
              args?: Record<string, unknown>;
              preview?: string;
              sessionId?: string;
              threadId?: string;
              inputTokens?: number;
              outputTokens?: number;
              costUsd?: number;
              factCount?: number;
              sources?: MobileTranscriptSource[];
            };

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
              const nextTool: MobileTranscriptToolCall = {
                name: event.name,
                status: event.status ?? 'running',
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
        onUpdateMessages(
          tabId,
          nextTranscript.map((entry) => entry.id === assistantId ? { ...entry, text: 'No response received' } : entry),
        );
      }
    } catch (err) {
      onUpdateMessages(tabId, [
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
      setSending(false);
      setAgentRunning(false);
      setLiveAssistantId(null);
      setStreamingText('');
      setActiveThinking(null);
      setStreamMeta({});
      setTimeout(() => {
        void fetchTranscript();
      }, 400);
    }
  }, [chatRuntime, fetchTranscript, linkedIssue, normalizedSessionKey, onUpdateMessages, onUpdateSessionKey, scrollToBottom, selectedModel, sending, tab.chatContinueLatest, tab.repo?.localPath, tabId, transportSessionId]);

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

  const llmMessages = useMemo<WorkspaceLlmMessage[]>(
    () => messages.map((message) => ({
      id: message.id,
      role: message.role === 'system' || message.role === 'tool' ? 'assistant' : message.role,
      content: message.text,
      model: message.model ?? (message.role === 'assistant' ? selectedModel?.label : undefined),
      timestamp: message.timestamp ?? Date.now(),
      tokens: message.tokens,
      costUsd: message.costUsd,
      toolCalls: message.toolCalls?.map((tool) => ({
        name: tool.name,
        status: tool.status ?? 'done',
        args: tool.args,
        preview: tool.preview,
      })),
      sources: message.sources,
      thinking: message.thinking,
      thinkingSteps: message.thinkingSteps,
      thinkingDurationMs: message.thinkingDurationMs,
      recalledFacts: message.recalledFacts,
      isError: /^error:/i.test(message.text.trim()),
    })),
    [messages, selectedModel],
  );

  const visibleMessages = useMemo(
    () => (agentRunning && liveAssistantId ? llmMessages.filter((message) => message.id !== liveAssistantId) : llmMessages),
    [agentRunning, liveAssistantId, llmMessages],
  );

  useEffect(() => {
    if (!scrollRef.current) return;
    if (visibleMessages.length === 0 && !streamingText && activeToolCalls.length === 0) return;
    scrollToBottom();
  }, [activeToolCalls.length, scrollToBottom, streamingText, visibleMessages.length]);

  const handleRetry = useCallback((messageId: string) => {
    const messageIndex = messagesRef.current.findIndex((entry) => entry.id === messageId);
    if (messageIndex < 0) return;
    const previousMessages = messagesRef.current.slice(0, messageIndex);
    const lastUser = [...previousMessages].reverse().find((entry) => entry.role === 'user');
    if (!lastUser) return;
    const baseMessages = previousMessages.filter((entry) => entry.id !== lastUser.id);
    onUpdateMessages(tabId, baseMessages);
    void sendText(lastUser.text, { baseMessages });
  }, [onUpdateMessages, sendText, tabId]);

  const handleEdit = useCallback((messageId: string, content: string) => {
    const messageIndex = messagesRef.current.findIndex((entry) => entry.id === messageId);
    if (messageIndex < 0) return;
    setDraft(content);
    onUpdateMessages(tabId, messagesRef.current.slice(0, messageIndex));
    requestAnimationFrame(() => composeRef.current?.focus());
  }, [onUpdateMessages, tabId]);

  const handleDelete = useCallback((messageId: string) => {
    const current = messagesRef.current;
    const messageIndex = current.findIndex((entry) => entry.id === messageId);
    if (messageIndex < 0) return;
    const message = current[messageIndex];
    if (!message) return;
    if (message.role === 'user' && current[messageIndex + 1]?.role === 'assistant') {
      onUpdateMessages(tabId, current.filter((_, index) => index !== messageIndex && index !== messageIndex + 1));
      return;
    }
    if (message.role === 'assistant' && messageIndex > 0 && current[messageIndex - 1]?.role === 'user') {
      onUpdateMessages(tabId, current.filter((_, index) => index !== messageIndex && index !== messageIndex - 1));
      return;
    }
    onUpdateMessages(tabId, current.filter((_, index) => index !== messageIndex));
  }, [onUpdateMessages, tabId]);

  const handleRemoveQueuedContext = useCallback((contextId: string) => {
    setQueuedContextCards((previous) => previous.filter((card) => card.id !== contextId));
  }, []);

  return {
    activeToolCalls,
    activeThinking,
    agentRunning,
    availableModels,
    canSend: draft.trim().length > 0 || queuedContextCards.length > 0,
    chatRuntime,
    composeRef,
    draft,
    fetchTranscript,
    handleDelete,
    handleEdit,
    handleRemoveQueuedContext,
    handleRetry,
    handleScroll,
    handleSend,
    isAgentTab,
    isRuntimeBound,
    issuePickerOpen,
    linkedIssue,
    llmMessages,
    messages,
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
    visibleMessages,
    onSelectModel,
  };
}
