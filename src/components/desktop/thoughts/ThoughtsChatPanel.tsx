'use client';

import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { CollapsiblePlanCard } from '@/components/desktop/CollapsiblePlanCard';
import { formatModelLabel } from '@/lib/format';
import { orchestratorRuntimeTone } from '@/lib/orchestrator/display';
import {
  queueOrchestratorSessionPrelude,
  readStoredOrchestratorModel,
  searchOrchestratorArchive,
  writeStoredOrchestratorModel,
} from '@/lib/orchestrator/store';
import type {
  OrchestratorMissionState,
  OrchestratorPacket,
  OrchestratorRuntime,
  OrchestratorWorkspaceTarget,
} from '@/lib/orchestrator/types';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import { serializeThreadToMarkdown, type ExportThreadMessage } from '@/lib/llm/export-thread';
import { executeOrchestratorSlashCommand } from '@/lib/slash-commands';
import { type ThinkingEffort } from './InputButtons';
import type { AgentTarget, FleetAgent } from './types';
import {
  entrySignature,
  generateSuggestions,
  isRenderableThoughtEntry,
  isRunnableCliSession,
  mergeTranscriptEntries,
} from './utils';
import { DEFAULT_ORCHESTRATOR_MODEL, useOrchestratorStream } from './useOrchestratorStream';
import { ChatMessageList } from './chat-panel/ChatMessageList';
import { ClearToast } from './chat-panel/ClearToast';
import { ComposerArea } from './chat-panel/ComposerArea';
import { EmptyStateCard } from './chat-panel/EmptyStateCard';
import { ThreadExportButton } from './chat-panel/ThreadExportButton';
import { useClearCommand } from './chat-panel/useClearCommand';
import { usePersistChatThread } from './chat-panel/usePersistChatThread';
import type {
  ThoughtsChatPanelChromeState,
  ThoughtsChatPanelHandle,
  ThoughtsChatPermissionMode,
} from './chat-panel/types';

export type { ThoughtsChatPanelHandle, ThoughtsChatPanelChromeState, ThoughtsChatPermissionMode };

type ThoughtsHistoryMessage = ExportThreadMessage & {
  id: string;
  role: MobileTranscriptEntry['role'];
  media?: MobileTranscriptEntry['media'];
  thinkingSteps?: MobileTranscriptEntry['thinkingSteps'];
  thinkingDurationMs?: MobileTranscriptEntry['thinkingDurationMs'];
  recalledFacts?: MobileTranscriptEntry['recalledFacts'];
  command?: MobileTranscriptEntry['command'];
  isPartial?: boolean;
  isCompaction?: boolean;
};

function mapHistoryMessagesToTranscript(messages: ThoughtsHistoryMessage[]): MobileTranscriptEntry[] {
  return messages
    .filter((message) => !message.isPartial)
    .map((message) => ({
      id: message.id,
      role: message.role,
      text: message.text ?? message.content ?? '',
      type: message.type ?? (message.compaction || message.isCompaction ? 'compaction' : 'message'),
      media: message.media,
      toolCalls: message.toolCalls,
      timestamp: message.timestamp ?? Date.now(),
      timestampLabel: message.timestampLabel ?? (message.timestamp
        ? new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : ''),
      model: message.model,
      tokens: message.tokens,
      costUsd: message.costUsd,
      sources: message.sources,
      thinking: message.thinking,
      thinkingSteps: message.thinkingSteps,
      thinkingDurationMs: message.thinkingDurationMs,
      recalledFacts: message.recalledFacts,
      command: message.command,
      compaction: message.compaction,
    }));
}

export const ThoughtsChatPanel = forwardRef<ThoughtsChatPanelHandle, {
  open: boolean;
  draftInjection?: { id: string; text: string } | null;
  agents: FleetAgent[];
  missionState: OrchestratorMissionState;
  preferredRuntime: OrchestratorRuntime;
  sessionTargets: AgentTarget[];
  workspaceTargets: OrchestratorWorkspaceTarget[];
  repoPath?: string | null;
  thoughtsBodyBackground: string;
  thoughtsElevatedSurface: string;
  thoughtsElevatedBorder: string;
  thoughtsElevatedShadow: string;
  thoughtsMutedGlass: string;
  permissionMode?: ThoughtsChatPermissionMode;
  onTogglePermission?: () => void;
  missionOpen?: boolean;
  onToggleMission?: () => void;
  repoLabel?: string | null;
  emptyStateOverride?: React.ReactNode;
  showInlineExport?: boolean;
  footerMeterSlot?: React.ReactNode;
  onMissionStateChange: (
    next: OrchestratorMissionState | ((current: OrchestratorMissionState) => OrchestratorMissionState)
  ) => void;
  onLaunchPacket?: (packet: OrchestratorPacket) => void;
  onChromeChange: (state: ThoughtsChatPanelChromeState) => void;
}>(function ThoughtsChatPanel({
  open,
  draftInjection,
  agents,
  missionState,
  preferredRuntime,
  sessionTargets,
  repoPath: repoPathProp,
  thoughtsBodyBackground,
  thoughtsElevatedSurface,
  thoughtsElevatedBorder,
  thoughtsElevatedShadow,
  thoughtsMutedGlass,
  permissionMode = 'full',
  onTogglePermission,
  missionOpen,
  onToggleMission,
  repoLabel,
  emptyStateOverride,
  showInlineExport = true,
  footerMeterSlot,
  onChromeChange,
}, ref) {
  const [input, setInput] = useState('');
  const [preEnhanceInput, setPreEnhanceInput] = useState<string | null>(null);
  const [enhancing, setEnhancing] = useState(false);
  const [thinkingEffort, setThinkingEffort] = useState<ThinkingEffort>('max');
  const [orchestratorModel, setOrchestratorModel] = useState(DEFAULT_ORCHESTRATOR_MODEL);
  const [chatMessages, setChatMessages] = useState<MobileTranscriptEntry[]>([]);
  const [planText, setPlanText] = useState<string | null>(null);
  const [waitingForReply, setWaitingForReply] = useState(false);
  const [targetAgentKey, setTargetAgentKey] = useState<string>('__claude__');
  const pollRef = useRef<number | null>(null);
  const pollDelayRef = useRef<number | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const seenServerEntriesRef = useRef<Map<string, string>>(new Map());
  const responseSeenRef = useRef(false);
  const idlePollsRef = useRef(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const orchestratorSessionRef = useRef<string | null>(null);
  const [orchestratorSpawning, setOrchestratorSpawning] = useState(false);
  const [threadId, setThreadId] = useState<string | null>(null);
  const threadIdRef = useRef<string | null>(null);
  const exportFeedbackTimerRef = useRef<number | null>(null);
  const [resolvedRepoPath, setResolvedRepoPath] = useState<string | null>(repoPathProp ?? null);
  const [exportState, setExportState] = useState<'idle' | 'copying' | 'copied' | 'error'>('idle');
  const { persistThread, persistThreadNow, cancelPendingPersist } = usePersistChatThread(resolvedRepoPath);

  const isOrchestratorMode = targetAgentKey === '__claude__' || !sessionTargets.some((s) => s.key === targetAgentKey);

  const orchStream = useOrchestratorStream(isOrchestratorMode ? resolvedRepoPath : null, {
    seededPlanText: planText,
    hasHistory: chatMessages.length > 0,
  });

  useEffect(() => {
    if (!resolvedRepoPath) return;
    setOrchestratorModel(readStoredOrchestratorModel(resolvedRepoPath) ?? DEFAULT_ORCHESTRATOR_MODEL);
  }, [resolvedRepoPath]);

  useEffect(() => {
    if (!isOrchestratorMode) return;
    if (!orchStream.planText || planText) return;
    setPlanText(orchStream.planText);
  }, [isOrchestratorMode, orchStream.planText, planText]);

  const targetAgent = useMemo(
    () => isOrchestratorMode ? null : (sessionTargets.find((agent) => agent.key === targetAgentKey) ?? null),
    [isOrchestratorMode, sessionTargets, targetAgentKey],
  );
  const targetSessionKey = targetAgent?.key ?? null;

  // ── Resolve repo path for orchestrator stream ──
  useEffect(() => {
    if (repoPathProp) {
      setResolvedRepoPath(repoPathProp);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/panel/repos');
        if (res.ok && !cancelled) {
          const data = await res.json() as { repos?: Array<{ localPath: string }> };
          const path = data.repos?.[0]?.localPath ?? null;
          if (path) setResolvedRepoPath(path);
        }
      } catch { /* silent */ }
    })();
    return () => { cancelled = true; };
  }, [repoPathProp]);

  // ── Pre-warm orchestrator session on mount ──
  useEffect(() => {
    if (!isOrchestratorMode || orchestratorSessionRef.current || orchestratorSpawning) return;

    let cancelled = false;
    (async () => {
      let repoPath = repoPathProp;
      if (!repoPath) {
        try {
          const res = await fetch('/api/panel/repos');
          if (res.ok) {
            const data = await res.json() as { repos?: Array<{ localPath: string }> };
            repoPath = data.repos?.[0]?.localPath ?? null;
          }
        } catch { /* silent */ }
      }
      if (!repoPath || cancelled) return;

      try {
        const invRes = await fetch('/api/runtime/inventory?fresh=1');
        if (invRes.ok && !cancelled) {
          const invData = await invRes.json() as { agents?: Array<{ sessionKey: string; runtime: string; status: string; workspace: string }> };
          const existing = (invData.agents ?? []).find(
            (a) => a.runtime === 'claude-code' && (a.status === 'idle' || a.status === 'reviewing') && a.workspace?.includes(repoPath!),
          );
          if (existing) {
            orchestratorSessionRef.current = existing.sessionKey;
            return;
          }
        }
      } catch { /* silent */ }

      if (cancelled) return;
      try {
        setOrchestratorSpawning(true);
        const launchRes = await fetch('/api/runtime/launch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            runtime: 'claude-code',
            prompt: 'You are the orchestrator for Cortex IDE. Acknowledge ready.',
            repoPath,
            cwd: repoPath,
            skipSetup: true,
          }),
        });
        const data = await launchRes.json() as { ok?: boolean; surfaceId?: string };
        if (data.ok && data.surfaceId && !cancelled) {
          orchestratorSessionRef.current = data.surfaceId;
        }
      } catch { /* silent */ } finally {
        if (!cancelled) setOrchestratorSpawning(false);
      }
    })();
    return () => { cancelled = true; };
  }, [isOrchestratorMode, orchestratorSpawning, repoPathProp]);

  useEffect(() => {
    if (!open || !draftInjection?.id) return;
    setInput((prev) => prev.trim()
      ? `${prev.trimEnd()}\n\n${draftInjection.text}\n\n`
      : `${draftInjection.text}\n\n`);
    setTimeout(() => inputRef.current?.focus(), 50);
  }, [draftInjection?.id, draftInjection?.text, open]);

  useEffect(() => {
    requestAnimationFrame(() => {
      chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    });
  }, [chatMessages, orchStream.messages]);

  useEffect(() => {
    return () => {
      if (pollRef.current !== null) window.clearInterval(pollRef.current);
      if (pollDelayRef.current !== null) window.clearTimeout(pollDelayRef.current);
      if (exportFeedbackTimerRef.current !== null) window.clearTimeout(exportFeedbackTimerRef.current);
    };
  }, []);

  const clearPolling = useCallback(() => {
    if (pollRef.current !== null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
    if (pollDelayRef.current !== null) {
      window.clearTimeout(pollDelayRef.current);
      pollDelayRef.current = null;
    }
  }, []);

  const setExportFeedback = useCallback((next: 'idle' | 'copying' | 'copied' | 'error') => {
    setExportState(next);
    if (exportFeedbackTimerRef.current !== null) {
      window.clearTimeout(exportFeedbackTimerRef.current);
      exportFeedbackTimerRef.current = null;
    }
    if (next === 'copied' || next === 'error') {
      exportFeedbackTimerRef.current = window.setTimeout(() => {
        setExportState('idle');
        exportFeedbackTimerRef.current = null;
      }, 1800);
    }
  }, []);

  const transcriptUrl = useCallback((sessionKey: string) => {
    if (sessionKey.startsWith('claude-code:') || sessionKey.startsWith('codex:') || sessionKey.startsWith('codex-owned:') || sessionKey.startsWith('codex-discovered:')) {
      return `/api/runtime/transcript?sessionKey=${encodeURIComponent(sessionKey)}&limit=20`;
    }
    return `/api/mobile/history?sessionKey=${encodeURIComponent(sessionKey)}&limit=20&fresh=1`;
  }, []);

  const captureServerSnapshot = useCallback(async (sessionKey: string) => {
    try {
      const res = await fetch(transcriptUrl(sessionKey));
      if (!res.ok) return;
      const data = await res.json();
      const entries = (data.transcript ?? data.entries ?? []) as MobileTranscriptEntry[];
      const nextSeen = new Map<string, string>();
      for (const entry of entries) {
        nextSeen.set(entry.id, entrySignature(entry));
      }
      seenServerEntriesRef.current = nextSeen;
    } catch {
      // silent
    }
  }, [transcriptUrl]);

  const startPollingForSession = useCallback((sessionKey: string) => {
    clearPolling();
    responseSeenRef.current = false;
    idlePollsRef.current = 0;

    let attempts = 0;
    const maxAttempts = 60;

    const poll = async () => {
      attempts++;
      if (attempts > maxAttempts) {
        clearPolling();
        setWaitingForReply(false);
        return;
      }

      try {
        const res = await fetch(transcriptUrl(sessionKey));
        if (!res.ok) return;

        const data = await res.json();
        const entries = (data.transcript ?? data.entries ?? []) as MobileTranscriptEntry[];
        const nextSeen = new Map(seenServerEntriesRef.current);
        const incoming: MobileTranscriptEntry[] = [];

        for (const entry of entries) {
          const signature = entrySignature(entry);
          const previousSignature = nextSeen.get(entry.id);
          nextSeen.set(entry.id, signature);

          if (previousSignature === signature) continue;
          if (entry.role === 'user') continue;
          if (!isRenderableThoughtEntry(entry)) continue;
          incoming.push(entry);
        }

        seenServerEntriesRef.current = nextSeen;

        if (incoming.length > 0) {
          responseSeenRef.current = true;
          idlePollsRef.current = 0;
          setChatMessages((prev) => mergeTranscriptEntries(prev, incoming));
          return;
        }

        if (responseSeenRef.current) {
          idlePollsRef.current += 1;
          if (idlePollsRef.current >= 4) {
            clearPolling();
            setWaitingForReply(false);
          }
        }
      } catch {
        // silent retry
      }
    };

    pollDelayRef.current = window.setTimeout(() => {
      void poll();
      pollRef.current = window.setInterval(() => {
        void poll();
      }, 1200);
    }, 400);
  }, [clearPolling, transcriptUrl]);

  const startPolling = useCallback(() => {
    const sessionKey = isOrchestratorMode ? orchestratorSessionRef.current : targetSessionKey;
    if (!sessionKey) {
      setWaitingForReply(false);
      return;
    }
    startPollingForSession(sessionKey);
  }, [isOrchestratorMode, startPollingForSession, targetSessionKey]);

  const resetRemoteSession = useCallback(async () => {
    try {
      const response = await fetch('/api/orchestrator/reset-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(resolvedRepoPath ? { repoPath: resolvedRepoPath } : {}),
      });
      return response.ok;
    } catch {
      return false;
    }
  }, [resolvedRepoPath]);

  const handleTaskSend = useCallback(async (explicitText?: string) => {
    const msg = (explicitText ?? input).trim();
    if (!msg) return;

    const effectiveWaiting = isOrchestratorMode ? orchStream.status === 'busy' : waitingForReply;
    if (effectiveWaiting) return;

    if (isOrchestratorMode && await runLocalOrchestratorSlash(msg)) {
      setInput('');
      return;
    }

    setInput('');

    if (isOrchestratorMode) {
      orchStream.send(msg, { permissionMode, thinkingEffort, model: orchestratorModel });
      return;
    }

    const userMsg: MobileTranscriptEntry = {
      id: `local-user-${Date.now()}`,
      role: 'user',
      text: msg,
      timestamp: Date.now(),
      timestampLabel: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    };
    setChatMessages((prev) => [...prev, userMsg]);

    const sessionKey = targetSessionKey;
    if (!sessionKey) return;
    setWaitingForReply(true);

    try {
      await captureServerSnapshot(sessionKey);

      const isRuntimeSession = sessionKey.startsWith('claude-code:') || sessionKey.startsWith('codex:') || sessionKey.startsWith('codex-owned:');
      const response = await fetch(isRuntimeSession ? '/api/runtime/action' : '/api/mobile/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: isRuntimeSession
          ? JSON.stringify({ action: 'steer', surfaceId: sessionKey, message: msg })
          : JSON.stringify({ action: 'resume', sessionKey, message: msg }),
      });

      if (!response.ok) {
        throw new Error('Send failed');
      }

      startPolling();
    } catch {
      setChatMessages((prev) => [
        ...prev,
        {
          id: `local-error-${Date.now()}`,
          role: 'system',
          text: 'Unable to reach the selected CLI lane. Make sure the Codex or Claude Code session is available.',
          timestamp: Date.now(),
          timestampLabel: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        },
      ]);
      setWaitingForReply(false);
    }
  }, [captureServerSnapshot, input, isOrchestratorMode, orchStream, orchestratorModel, permissionMode, runLocalOrchestratorSlash, startPolling, targetSessionKey, thinkingEffort, waitingForReply]);

  const handleReset = useCallback(() => {
    setInput('');
    setPreEnhanceInput(null);
    setChatMessages([]);
    setPlanText(null);
    setWaitingForReply(false);
    clearPolling();
    seenServerEntriesRef.current.clear();
    responseSeenRef.current = false;
    idlePollsRef.current = 0;
    orchStream.reset();
    threadIdRef.current = null;
    setThreadId(null);
    autoRestoreAttemptedRef.current = true;
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('o8:orchestrator:auto-restore-suppressed', '1');
    }
    cancelPendingPersist();
    if (abortRef.current) { abortRef.current.abort(); abortRef.current = null; }
    setTimeout(() => inputRef.current?.focus(), 50);
  }, [cancelPendingPersist, clearPolling, orchStream]);

  const handleEnhance = useCallback(async () => {
    if (!input.trim() || enhancing) return;
    setEnhancing(true);
    setPreEnhanceInput(input);
    try {
      const res = await fetch('/api/mobile/enhance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: input }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.enhanced) setInput(data.enhanced);
      }
    } catch {
      // silently fail
    } finally {
      setEnhancing(false);
    }
  }, [input, enhancing]);

  const handleUndoEnhance = useCallback(() => {
    if (preEnhanceInput !== null) {
      setInput(preEnhanceInput);
      setPreEnhanceInput(null);
    }
  }, [preEnhanceInput]);

  // ── Thread persistence ──

  useEffect(() => {
    const msgs = isOrchestratorMode
      ? (orchStream.messages.length > 0 ? orchStream.messages : chatMessages)
      : chatMessages;
    if (msgs.length === 0 || !isOrchestratorMode) return;

    const hasUserMessage = msgs.some((m) => m.role === 'user');
    if (!hasUserMessage) return;

    if (!threadIdRef.current) {
      const newId = `thoughts-${Date.now()}`;
      threadIdRef.current = newId;
      setThreadId(newId);
      persistThread(msgs, newId, planText);
    } else {
      persistThread(msgs, threadIdRef.current, planText);
    }
  }, [chatMessages, orchStream.messages, isOrchestratorMode, persistThread, planText]);

  const autoRestoreAttemptedRef = useRef(false);
  const AUTO_RESTORE_SUPPRESSED_KEY = 'o8:orchestrator:auto-restore-suppressed';
  useEffect(() => {
    if (!isOrchestratorMode) return;
    if (autoRestoreAttemptedRef.current) return;
    if (orchStream.messages.length > 0 || chatMessages.length > 0) return;
    autoRestoreAttemptedRef.current = true;
    if (typeof window !== 'undefined' && window.localStorage.getItem(AUTO_RESTORE_SUPPRESSED_KEY) === '1') {
      window.localStorage.removeItem(AUTO_RESTORE_SUPPRESSED_KEY);
      return;
    }
    void (async () => {
      try {
        const res = await fetch('/api/v2/chat-history/list?include=orchestrator');
        if (!res.ok) return;
        const data = await res.json() as { conversations?: Array<{ tabId: string; modifiedAt?: string }> };
        const thoughtsThreads = (data.conversations ?? [])
          .filter((t) => t.tabId.startsWith('thoughts-'))
          .sort((a, b) => new Date(b.modifiedAt ?? 0).getTime() - new Date(a.modifiedAt ?? 0).getTime());
        if (thoughtsThreads.length > 0) {
          const latest = thoughtsThreads[0];
          const histRes = await fetch(`/api/v2/chat-history?tabId=${encodeURIComponent(latest.tabId)}`);
          if (!histRes.ok) return;
          const histData = await histRes.json() as {
            messages?: ThoughtsHistoryMessage[];
            planText?: string | null;
          };
          const msgs = mapHistoryMessagesToTranscript(histData.messages ?? []);
          setPlanText(histData.planText ?? null);
          if (msgs.length > 0) {
            setChatMessages(msgs);
            orchStream.replaceTranscript(msgs);
            threadIdRef.current = latest.tabId;
            setThreadId(latest.tabId);
          }
        }
      } catch {
        // silent
      }
    })();
  }, [isOrchestratorMode, orchStream.messages.length, orchStream.replaceTranscript, chatMessages.length]);

  const { showClearToast, handleClearCommand } = useClearCommand({
    isOrchestratorMode,
    orchStreamMessages: orchStream.messages,
    orchStreamPlanText: orchStream.planText,
    chatMessages,
    planText,
    threadIdRef,
    resolvedRepoPath,
    persistThreadNow,
    cancelPendingPersist,
    handleReset,
  });

  const handleLoadThread = useCallback(async (tabId: string) => {
    try {
      const res = await fetch(`/api/v2/chat-history?tabId=${encodeURIComponent(tabId)}`);
      if (!res.ok) return;
      const data = await res.json() as {
        messages?: ThoughtsHistoryMessage[];
        planText?: string | null;
      };
      const msgs = mapHistoryMessagesToTranscript(data.messages ?? []);
      setChatMessages(msgs);
      setPlanText(data.planText ?? null);
      threadIdRef.current = tabId;
      setThreadId(tabId);
      setWaitingForReply(false);
      clearPolling();
      orchStream.reset();
      orchStream.replaceTranscript(msgs);
      seenServerEntriesRef.current.clear();
      orchestratorSessionRef.current = null;
      setTimeout(() => inputRef.current?.focus(), 50);
    } catch {
      // silent
    }
  }, [clearPolling, orchStream]);

  const suggestions = useMemo(
    () => generateSuggestions(agents.filter(isRunnableCliSession), sessionTargets),
    [agents, sessionTargets],
  );
  const displayMessages = useMemo(() => {
    if (!isOrchestratorMode) return chatMessages;
    return orchStream.messages.length > 0 ? orchStream.messages : chatMessages;
  }, [chatMessages, isOrchestratorMode, orchStream.messages]);
  const displayWaiting = isOrchestratorMode ? orchStream.status === 'busy' : waitingForReply;
  const displayPlanText = isOrchestratorMode && planText?.trim() ? planText.trim() : null;
  const hasAssistantActivity = displayMessages.some((message) => message.role !== 'user');
  const activeTargetLabel = isOrchestratorMode ? 'Claude Code' : (targetAgent?.name ?? orchestratorRuntimeTone(preferredRuntime).label);
  const activeTargetColor = isOrchestratorMode ? '#e07a3a' : (targetAgent?.color ?? orchestratorRuntimeTone(preferredRuntime).color);
  const transcriptTopContent = displayPlanText ? (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 0,
      }}
    >
      <CollapsiblePlanCard key={`plan-${threadId ?? 'active'}`} text={displayPlanText} />
    </div>
  ) : null;

  useEffect(() => {
    onChromeChange({
      activeTargetLabel,
      waitingForReply: displayWaiting,
      hasMessages: displayMessages.length > 0,
      threadId,
      messageCount: displayMessages.length,
      orchestratorBusyState: orchStream.busyState,
    });
  }, [activeTargetLabel, displayMessages.length, displayWaiting, onChromeChange, orchStream.busyState, threadId]);

  // Ref used so sendNow() can flush the latest input value without a re-render.
  const latestInputRef = useRef('');
  useEffect(() => { latestInputRef.current = input; }, [input]);

  async function runLocalOrchestratorSlash(rawInput: string) {
    if (!isOrchestratorMode) return false;

    const handled = await executeOrchestratorSlashCommand(rawInput, {
      repoPath: resolvedRepoPath,
      transcript: displayMessages,
      missionState,
      runningTotal: orchStream.runningTotal,
      currentModel: orchestratorModel,
      setCurrentModel: (model) => {
        setOrchestratorModel(model);
        writeStoredOrchestratorModel(resolvedRepoPath, model);
      },
      appendEntries: orchStream.appendLocalEntries,
      replaceTranscript: orchStream.replaceTranscript,
      compactNow: orchStream.compactNow,
      resetRemoteSession,
      queuePrelude: (prelude, mode) => queueOrchestratorSessionPrelude(resolvedRepoPath, prelude, mode),
      searchArchive: (query, limit) => searchOrchestratorArchive(resolvedRepoPath, query, limit),
      fetchTelemetry: async () => {
        const snapshot = await orchStream.fetchTelemetrySnapshot();
        return {
          totalTokens: snapshot.totalTokens,
          estimatedCostUsd: snapshot.estimatedCostUsd,
          model: snapshot.model,
        };
      },
      clearThread: handleClearCommand,
    });
    if (!handled.handled) return false;
    latestInputRef.current = '';
    return true;
  }

  const sendNow = useCallback((text?: string) => {
    const msg = (typeof text === 'string' ? text : latestInputRef.current).trim();
    if (!msg) return;

    if (isOrchestratorMode) {
      if (orchStream.status === 'busy') return;
      void (async () => {
        if (await runLocalOrchestratorSlash(msg)) {
          setInput('');
          latestInputRef.current = '';
          return;
        }
        setInput('');
        latestInputRef.current = '';
        orchStream.send(msg, { permissionMode, thinkingEffort, model: orchestratorModel });
      })();
      return;
    }

    setInput(msg);
    latestInputRef.current = msg;
    setTimeout(() => { void handleTaskSend(msg); }, 0);
  }, [handleTaskSend, isOrchestratorMode, orchStream, orchestratorModel, permissionMode, runLocalOrchestratorSlash, thinkingEffort]);

  const handleCopyMarkdownRef = useRef<() => Promise<boolean>>(async () => false);

  useImperativeHandle(ref, () => ({
    focusInput() {
      inputRef.current?.focus();
    },
    reset: handleReset,
    loadThread: handleLoadThread,
    sendNow,
    copyAsMarkdown: () => handleCopyMarkdownRef.current(),
  }), [handleReset, handleLoadThread, sendNow]);

  const fallbackEmptyState = (
    <EmptyStateCard
      isOrchestratorMode={isOrchestratorMode}
      targetAgent={targetAgent}
      activeTargetLabel={activeTargetLabel}
      activeTargetColor={activeTargetColor}
      thoughtsElevatedSurface={thoughtsElevatedSurface}
      thoughtsElevatedBorder={thoughtsElevatedBorder}
      thoughtsElevatedShadow={thoughtsElevatedShadow}
      suggestions={suggestions}
      onSelectSuggestion={(suggestion) => {
        setTargetAgentKey(suggestion.agent.key);
        setInput(suggestion.action);
        setTimeout(() => inputRef.current?.focus(), 50);
      }}
    />
  );

  const handleSlashCommand = useCallback((cmd: string) => {
    setInput(cmd);
    latestInputRef.current = cmd;
    void handleTaskSend(cmd);
    setTimeout(() => inputRef.current?.focus(), 50);
  }, [handleTaskSend]);

  const handleCopyMarkdown = useCallback(async (): Promise<boolean> => {
    if (displayMessages.length === 0) return false;
    if (!navigator.clipboard?.writeText) {
      console.log('[export-thread] Clipboard API unavailable for active thread export');
      setExportFeedback('error');
      return false;
    }

    setExportFeedback('copying');
    try {
      const markdown = serializeThreadToMarkdown(displayMessages, { threadId });
      await navigator.clipboard.writeText(markdown);
      console.log(`[export-thread] Copied active thread ${threadId ?? 'unsaved-thread'} to clipboard`);
      setExportFeedback('copied');
      return true;
    } catch (error) {
      console.log('[export-thread] Failed to copy active thread markdown', error);
      setExportFeedback('error');
      return false;
    }
  }, [displayMessages, setExportFeedback, threadId]);

  useEffect(() => {
    handleCopyMarkdownRef.current = handleCopyMarkdown;
  }, [handleCopyMarkdown]);

  return (
    <>
      {displayMessages.length > 0 && showInlineExport ? (
        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            paddingTop: 10,
            paddingRight: 16,
            paddingBottom: 0,
            paddingLeft: 16,
            flexShrink: 0,
          }}
        >
          <ThreadExportButton state={exportState} onClick={() => { void handleCopyMarkdown(); }} />
        </div>
      ) : null}

      <ChatMessageList
        ref={chatEndRef}
        displayMessages={displayMessages}
        displayWaiting={displayWaiting}
        repoPath={resolvedRepoPath}
        activeTargetLabel={activeTargetLabel}
        activeTargetColor={activeTargetColor}
        thoughtsBodyBackground={thoughtsBodyBackground}
        thoughtsMutedGlass={thoughtsMutedGlass}
        thoughtsElevatedBorder={thoughtsElevatedBorder}
        thoughtsElevatedShadow={thoughtsElevatedShadow}
        emptyStateOverride={emptyStateOverride}
        emptyStateFallback={fallbackEmptyState}
        topContent={transcriptTopContent}
        isOrchestratorMode={isOrchestratorMode}
      />

      {showClearToast ? (
        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            paddingTop: 0,
            paddingRight: 12,
            paddingBottom: 8,
            paddingLeft: 12,
            background: thoughtsBodyBackground,
            flexShrink: 0,
            pointerEvents: 'none',
          }}
        >
          <ClearToast />
        </div>
      ) : null}

      <ComposerArea
        ref={inputRef}
        input={input}
        onInputChange={setInput}
        isOrchestratorMode={isOrchestratorMode}
        displayWaiting={displayWaiting}
        chatMessages={chatMessages}
        activeTargetLabel={activeTargetLabel}
        targetAgentExists={Boolean(targetAgent)}
        thoughtsBodyBackground={thoughtsBodyBackground}
        enhancing={enhancing}
        preEnhanceInput={preEnhanceInput}
        onEnhance={handleEnhance}
        onUndoEnhance={handleUndoEnhance}
        onSubmit={() => { void handleTaskSend(); }}
        onSlashCommand={handleSlashCommand}
        modelLabel={isOrchestratorMode ? formatModelLabel(orchestratorModel) : activeTargetLabel}
        effort={thinkingEffort}
        onEffortChange={setThinkingEffort}
        permissionMode={permissionMode}
        onTogglePermission={onTogglePermission}
        missionOpen={missionOpen}
        onToggleMission={onToggleMission}
        repoLabel={repoLabel}
        displayMessagesCount={displayMessages.length}
        hasAssistantActivity={hasAssistantActivity}
        footerMeterSlot={footerMeterSlot}
      />
    </>
  );
});
