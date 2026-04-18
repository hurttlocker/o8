'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  MobileTranscriptEntry,
  MobileTranscriptToolLaunchLink,
} from '@/lib/mobile/types';
import {
  clearQueuedOrchestratorSessionPrelude,
  consumeOrchestratorSessionPrelude,
  hasQueuedOrchestratorSessionPrelude,
  subscribeOrchestratorMissionCompleted,
  type OrchestratorMissionCompletedDetail,
} from '@/lib/orchestrator/store';
import type { ThinkingEffort } from '@/lib/orchestrator/thinking-effort';
import type { ThoughtsOrchestratorBusyState } from '@/components/desktop/thoughts/chat-panel/types';
import { archiveMissionThread as archiveCompletedMissionThread } from './use-orchestrator-stream/mission-history';
import {
  primeCompactedOrchestratorSession,
  refreshOrchestratorTokenTelemetry,
  requestOrchestratorCompaction,
} from './use-orchestrator-stream/session';
import {
  DEFAULT_ORCHESTRATOR_MODEL,
  ORCHESTRATOR_AUTO_COMPACT_RESET_FLOOR,
  ORCHESTRATOR_AUTO_COMPACT_THRESHOLD,
  ORCHESTRATOR_COMPACTION_STATUS_MIN_MS,
  ORCHESTRATOR_FORCE_COMPACT_THRESHOLD,
  ORCHESTRATOR_NEXT_TURN_BUFFER_TOKENS,
  ORCHESTRATOR_SYSTEM_PROMPT_ESTIMATE_TOKENS,
  approxTokens,
  createIdleBusyState,
  emitTokenUsage,
  formatTimestampLabel,
  getWsUrl,
  normalizeRepoPath,
  sortTranscriptEntries,
  type OrchestratorPermissionMode,
  type OrchestratorStreamStatus,
} from './use-orchestrator-stream/shared';
import {
  createOrchestratorMessageHandler,
  type CurrentAssistantStreamState,
} from './use-orchestrator-stream/socket';

export {
  DEFAULT_ORCHESTRATOR_MODEL,
  ORCHESTRATOR_TOKEN_EVENT,
} from './use-orchestrator-stream/shared';
export type {
  OrchestratorPermissionMode,
  OrchestratorStreamStatus,
  OrchestratorTokenUsageDetail,
} from './use-orchestrator-stream/shared';

interface OrchestratorStreamResult {
  messages: MobileTranscriptEntry[];
  planText: string | null;
  status: OrchestratorStreamStatus;
  busyState: ThoughtsOrchestratorBusyState;
  tokenCount: number;
  runningTotal: number;
  estimateNextTurnTokens: (message: string) => number;
  send: (message: string, options?: { permissionMode?: OrchestratorPermissionMode; thinkingEffort?: ThinkingEffort; model?: string }) => void;
  appendLocalEntries: (entries: MobileTranscriptEntry[]) => void;
  replaceTranscript: (entries: MobileTranscriptEntry[]) => void;
  fetchTelemetrySnapshot: () => Promise<{ totalTokens: number | null; estimatedCostUsd: number | null; model: string | null }>;
  compactNow: (options?: { keepTailCount?: number; source?: 'manual' | 'handoff' }) => Promise<{
    applied: boolean;
    transcript: MobileTranscriptEntry[];
    resumePrelude: string | null;
    tokensAfter: number;
  } | null>;
  reset: () => void;
  connected: boolean;
}

interface ActiveTurnState {
  startedAt: number;
  toolCallsStarted: number;
  toolCallsCompleted: number;
  latestToolLabel: string | null;
  launches: MobileTranscriptToolLaunchLink[];
}

/**
 * Hook that connects to the orchestrator WebSocket channel for real-time
 * Claude Code streaming. Replaces the poll-based orchestrator flow.
 *
 * Connects to ws-server on port 3002, subscribes to the orchestrator channel,
 * and accumulates output into renderable MobileTranscriptEntry messages.
 */
export function useOrchestratorStream(
  repoPath: string | null,
  options?: { seededPlanText?: string | null; hasHistory?: boolean },
): OrchestratorStreamResult {
  const [messages, setMessages] = useState<MobileTranscriptEntry[]>([]);
  const [planText, setPlanText] = useState<string | null>(null);
  const [status, setStatus] = useState<OrchestratorStreamStatus>('connecting');
  const [busyState, setBusyState] = useState<ThoughtsOrchestratorBusyState>(() => createIdleBusyState());
  const [connected, setConnected] = useState(false);
  const [tokenCount, setTokenCount] = useState(0);
  const [runningTotal, setRunningTotal] = useState(0);
  const wsRef = useRef<WebSocket | null>(null);
  const resetEpochRef = useRef(0);
  const currentAssistantRef = useRef<CurrentAssistantStreamState | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tokenRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const telemetrySessionKeyRef = useRef<string | null>(null);
  const telemetryTotalRef = useRef<number | null>(null);
  const statusRef = useRef(status);
  statusRef.current = status;
  const repoPathRef = useRef(repoPath);
  repoPathRef.current = repoPath;
  const runningTotalRef = useRef(runningTotal);
  runningTotalRef.current = runningTotal;
  const mountedRef = useRef(false);
  const messagesRef = useRef<MobileTranscriptEntry[]>([]);
  const planTextRef = useRef<string | null>(null);
  const hasHistory = options?.hasHistory ?? false;
  const seededPlanText = options?.seededPlanText ?? null;

  const hasHistoryRef = useRef(Boolean(hasHistory));
  const captureFirstTurnPlanRef = useRef(false);
  const firstTurnPlanStartedRef = useRef(false);
  const firstTurnPlanChunksRef = useRef<string[]>([]);
  const activeTurnRef = useRef<ActiveTurnState | null>(null);
  const autoCompactInFlightRef = useRef(false);
  const autoCompactArmedRef = useRef(true);
  const missionRotationInFlightRef = useRef(false);
  const pendingMissionCompletionRef = useRef<OrchestratorMissionCompletedDetail | null>(null);
  const transitionStripTimerRef = useRef<number | null>(null);

  // #539 — reconnect reconciliation. eventCountRef advances on every relevant
  // orchestrator event; lastEventAtRef tracks wall-clock time of the last
  // event. Together they let us detect stale "busy" state after a ws-server
  // restart (no events arrive post-reconnect) or a dead backend turn (no
  // events for > HEAL_STALE_AFTER_MS while the UI still thinks it's working).
  const eventCountRef = useRef(0);
  const lastEventAtRef = useRef<number>(Date.now());
  const RECONNECT_HEAL_DELAY_MS = 3000;
  const HEAL_STALE_AFTER_MS = 300_000;
  const HEAL_POLL_INTERVAL_MS = 30_000;

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    hasHistoryRef.current = Boolean(hasHistory);
  }, [hasHistory]);

  useEffect(() => {
    const trimmed = seededPlanText?.trim();
    if (!trimmed || planTextRef.current === trimmed) {
      return;
    }

    planTextRef.current = trimmed;
    setPlanText(trimmed);
  }, [seededPlanText]);

  const resetFirstTurnPlanCapture = useCallback(() => {
    captureFirstTurnPlanRef.current = false;
    firstTurnPlanStartedRef.current = false;
    firstTurnPlanChunksRef.current = [];
  }, []);

  const finalizeFirstTurnPlanCapture = useCallback(() => {
    if (!captureFirstTurnPlanRef.current || planTextRef.current) {
      resetFirstTurnPlanCapture();
      return;
    }

    const nextPlanText = firstTurnPlanChunksRef.current.join('').trim();
    resetFirstTurnPlanCapture();

    if (!nextPlanText) {
      return;
    }

    planTextRef.current = nextPlanText;
    setPlanText(nextPlanText);
  }, [resetFirstTurnPlanCapture]);

  const syncMessages = useCallback((entries: MobileTranscriptEntry[]) => {
    messagesRef.current = entries;
    setMessages(entries);
  }, []);

  const updateRunningTotal = useCallback((value: number) => {
    runningTotalRef.current = value;
    setRunningTotal(value);
  }, []);

  const refreshTokenTelemetry = useCallback(async () => {
    return await refreshOrchestratorTokenTelemetry({
      repoPath: repoPathRef.current,
      setRunningTotal: updateRunningTotal,
      setTokenCount,
      telemetrySessionKeyRef,
      telemetryTotalRef,
    });
  }, [updateRunningTotal]);

  const requestCompaction = useCallback(async (
    activeRepoPath: string,
    nextRunningTotal: number,
    nextMessages: MobileTranscriptEntry[],
    options?: { keepTailCount?: number; trigger?: 'auto' | 'manual' | 'handoff' },
  ) => {
    return await requestOrchestratorCompaction(activeRepoPath, nextRunningTotal, nextMessages, options);
  }, []);

  const primeCompactedSession = useCallback(async (
    activeRepoPath: string,
    payload: Awaited<ReturnType<typeof requestOrchestratorCompaction>>,
    options?: { setTranscript?: boolean },
  ) => {
    if (!payload) return null;
    return await primeCompactedOrchestratorSession({
      messagesRef,
      payload,
      repoPath: activeRepoPath,
      setMessages: syncMessages,
      setRunningTotal: updateRunningTotal,
      setTokenCount,
      setTranscript: options?.setTranscript,
      telemetrySessionKeyRef,
      telemetryTotalRef,
    });
  }, [syncMessages, updateRunningTotal]);

  const estimateNextTurnTokens = useCallback((message: string) => (
    runningTotalRef.current
    + ORCHESTRATOR_SYSTEM_PROMPT_ESTIMATE_TOKENS
    + ORCHESTRATOR_NEXT_TURN_BUFFER_TOKENS
    + approxTokens(message)
  ), []);

  const replaceTranscript = useCallback((entries: MobileTranscriptEntry[]) => {
    const next = sortTranscriptEntries(entries);
    syncMessages(next);
  }, [syncMessages]);

  const appendLocalEntries = useCallback((entries: MobileTranscriptEntry[]) => {
    if (entries.length === 0) return;
    setMessages((prev) => {
      const next = [...prev];
      const indexById = new Map(next.map((entry, index) => [entry.id, index] as const));
      for (const entry of entries) {
        const existingIndex = indexById.get(entry.id);
        if (existingIndex == null) {
          indexById.set(entry.id, next.length);
          next.push(entry);
        } else {
          next[existingIndex] = entry;
        }
      }
      const sorted = sortTranscriptEntries(next);
      messagesRef.current = sorted;
      return sorted;
    });
  }, []);

  const reset = useCallback(() => {
    const nextStatus = connected ? 'ready' : 'connecting';
    resetEpochRef.current += 1;
    syncMessages([]);
    planTextRef.current = null;
    setPlanText(null);
    setBusyState(createIdleBusyState());
    activeTurnRef.current = null;
    setTokenCount(0);
    updateRunningTotal(0);
    currentAssistantRef.current = null;
    hasHistoryRef.current = false;
    telemetrySessionKeyRef.current = null;
    telemetryTotalRef.current = null;
    autoCompactInFlightRef.current = false;
    autoCompactArmedRef.current = true;
    resetFirstTurnPlanCapture();
    statusRef.current = nextStatus;
    lastEventAtRef.current = Date.now();
    setStatus(nextStatus);
    if (transitionStripTimerRef.current) {
      clearTimeout(transitionStripTimerRef.current);
      transitionStripTimerRef.current = null;
    }
    clearQueuedOrchestratorSessionPrelude(repoPathRef.current);
    emitTokenUsage({ repoPath: repoPathRef.current, tokenCount: 0, runningTotal: 0 });
  }, [connected, resetFirstTurnPlanCapture, syncMessages, updateRunningTotal]);

  const archiveMissionThread = useCallback(async (detail: OrchestratorMissionCompletedDetail) => {
    const activeRepoPath = repoPathRef.current;
    if (!activeRepoPath) return;
    await archiveCompletedMissionThread(detail, {
      appendLocalEntries,
      planText: planTextRef.current,
      replaceTranscript,
      repoPath: activeRepoPath,
      reset,
      transcript: messagesRef.current,
      transitionStripTimerRef,
    });
  }, [appendLocalEntries, replaceTranscript, reset]);

  const rotateMissionThread = useCallback(async (detail: OrchestratorMissionCompletedDetail) => {
    const activeRepoPath = normalizeRepoPath(repoPathRef.current);
    const eventRepoPath = normalizeRepoPath(detail.repoPath);
    if (!activeRepoPath || (eventRepoPath && eventRepoPath !== activeRepoPath)) {
      return;
    }
    if (missionRotationInFlightRef.current) {
      pendingMissionCompletionRef.current = detail;
      return;
    }

    missionRotationInFlightRef.current = true;
    try {
      await archiveMissionThread(detail);
      if (pendingMissionCompletionRef.current === detail) {
        pendingMissionCompletionRef.current = null;
      }
    } catch (error) {
      console.error('[orchestrator-stream] Failed to rotate completed mission thread.', error);
    } finally {
      missionRotationInFlightRef.current = false;
      const pending = pendingMissionCompletionRef.current;
      if (pending && pending !== detail && statusRef.current !== 'busy') {
        pendingMissionCompletionRef.current = null;
        queueMicrotask(() => {
          void rotateMissionThread(pending);
        });
      }
    }
  }, [archiveMissionThread]);

  const endTurn = useCallback(() => {
    activeTurnRef.current = null;
    setBusyState(createIdleBusyState());
  }, []);

  // #539 — clear any stale "running" state when the client's local view of
  // a busy turn no longer matches reality. Used by both the reconnect heal
  // and the heartbeat-based stall detector. Idempotent — safe to call when
  // nothing needs healing.
  const healStaleBusyState = useCallback((reason: string) => {
    const hasStaleStatus = statusRef.current === 'busy';
    const hasOrphanAssistant = currentAssistantRef.current !== null;
    const hasRunningTools = messagesRef.current.some((m) =>
      m.toolCalls?.some((t) => t.status === 'running'),
    );
    if (!hasStaleStatus && !hasOrphanAssistant && !hasRunningTools) return;

    console.warn(`[orchestrator-stream] Healing stale busy state: ${reason}`);
    if (hasStaleStatus) setStatus('ready');
    if (hasOrphanAssistant) currentAssistantRef.current = null;
    endTurn();
    if (hasRunningTools) {
      setMessages((prev) =>
        prev.map((m) =>
          m.toolCalls?.some((t) => t.status === 'running')
            ? { ...m, toolCalls: m.toolCalls.map((t) => (t.status === 'running' ? { ...t, status: 'done' as const } : t)) }
            : m,
        ),
      );
    }
  }, [endTurn]);

  const flushCurrentAssistant = useCallback(() => {
    const current = currentAssistantRef.current;
    if (!current || (current.chunks.length === 0 && current.thinkingChunks.length === 0)) return;

    const text = current.chunks.join('\n');
    const thinking = current.thinkingChunks.length > 0 ? current.thinkingChunks.join('\n') : undefined;
    setMessages(prev => {
      const idx = prev.findIndex(m => m.id === current.id);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = {
          ...next[idx],
          text: text || (thinking ? '' : ''),
          thinking,
          timestamp: next[idx].timestamp ?? Date.now(),
          timestampLabel: next[idx].timestampLabel ?? formatTimestampLabel(Date.now()),
        };
        return next;
      }
      return [...prev, {
        id: current.id,
        role: 'assistant',
        text: text || (thinking ? '' : ''),
        thinking,
        timestamp: Date.now(),
        timestampLabel: formatTimestampLabel(Date.now()),
      }];
    });
  }, []);

  const connect = useCallback(() => {
    if (!repoPathRef.current) return;
    if (wsRef.current?.readyState === WebSocket.OPEN || wsRef.current?.readyState === WebSocket.CONNECTING) return;
    const wsUrl = getWsUrl();
    if (!wsUrl) return;

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      setStatus('connecting');

      // Subscribe to orchestrator channel
      ws.send(JSON.stringify({
        type: 'orchestrator-subscribe',
        repoPath: repoPathRef.current,
      }));

      console.log('[orchestrator-stream] Connected, subscribing...');

      // #539 — reconnect heal. If this is a fresh connect, status is already
      // 'connecting' and the heal is a no-op. If we're reconnecting after a
      // ws-server restart or a network flap, any "busy" state we carried over
      // is potentially stale. Give the server 3 seconds to push events for a
      // genuinely active turn; if nothing arrives, clear the stale indicators.
      const countAtOpen = eventCountRef.current;
      setTimeout(() => {
        if (ws !== wsRef.current) return;
        if (eventCountRef.current !== countAtOpen) return;
        if (statusRef.current === 'busy' || currentAssistantRef.current) {
          healStaleBusyState('reconnect with no follow-up events after 3s');
        }
      }, RECONNECT_HEAL_DELAY_MS);
    };

    ws.onmessage = createOrchestratorMessageHandler({
      captureFirstTurnPlanRef,
      currentWs: ws,
      currentAssistantRef,
      eventCountRef,
      finalizeFirstTurnPlanCapture,
      firstTurnPlanChunksRef,
      firstTurnPlanStartedRef,
      flushCurrentAssistant,
      lastEventAtRef,
      messagesRef,
      resetEpochRef,
      setMessages,
      setStatus,
      statusRef,
      wsRef,
    });

    ws.onclose = () => {
      setConnected(false);
      wsRef.current = null;
      console.log('[orchestrator-stream] Disconnected');

      // Auto-reconnect after 2s — but only if still mounted
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (!mountedRef.current) return;
      reconnectTimerRef.current = setTimeout(() => {
        if (repoPathRef.current && mountedRef.current) connect();
      }, 2000);
    };

    ws.onerror = () => {
      // onclose will fire after this
    };
  }, [finalizeFirstTurnPlanCapture, flushCurrentAssistant, healStaleBusyState]);

  // Connect on mount / repoPath change
  useEffect(() => {
    if (!repoPath) return;

    mountedRef.current = true;
    telemetrySessionKeyRef.current = null;
    telemetryTotalRef.current = null;
    setTokenCount(0);
    updateRunningTotal(0);
    emitTokenUsage({ repoPath, tokenCount: 0, runningTotal: 0 });
    connect();
    if (tokenRefreshTimerRef.current) clearTimeout(tokenRefreshTimerRef.current);
    tokenRefreshTimerRef.current = setTimeout(() => {
      void refreshTokenTelemetry();
    }, 1200);

    return () => {
      mountedRef.current = false;
      if (tokenRefreshTimerRef.current) {
        clearTimeout(tokenRefreshTimerRef.current);
        tokenRefreshTimerRef.current = null;
      }
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (wsRef.current) {
        // Unsubscribe before closing
        if (wsRef.current.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ type: 'orchestrator-unsubscribe' }));
        }
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [repoPath, connect, refreshTokenTelemetry, updateRunningTotal]);

  useEffect(() => {
    if (!repoPath) return () => {};

    return subscribeOrchestratorMissionCompleted((detail) => {
      const activeRepoPath = normalizeRepoPath(repoPathRef.current);
      const eventRepoPath = normalizeRepoPath(detail.repoPath);
      if (!activeRepoPath || (eventRepoPath && eventRepoPath !== activeRepoPath)) return;
      pendingMissionCompletionRef.current = detail;
      if (statusRef.current !== 'busy') {
        void rotateMissionThread(detail);
      }
    });
  }, [repoPath, rotateMissionThread]);

  useEffect(() => {
    if (!repoPath || status !== 'ready') return;
    if (tokenRefreshTimerRef.current) clearTimeout(tokenRefreshTimerRef.current);
    tokenRefreshTimerRef.current = setTimeout(() => {
      void refreshTokenTelemetry();
    }, 900);
    return () => {
      if (tokenRefreshTimerRef.current) {
        clearTimeout(tokenRefreshTimerRef.current);
        tokenRefreshTimerRef.current = null;
      }
    };
  }, [repoPath, refreshTokenTelemetry, status]);

  useEffect(() => {
    if (status === 'busy' || missionRotationInFlightRef.current || !pendingMissionCompletionRef.current) return;
    void rotateMissionThread(pendingMissionCompletionRef.current);
  }, [rotateMissionThread, status]);

  useEffect(() => {
    if (!repoPath) return;
    if (runningTotal < ORCHESTRATOR_AUTO_COMPACT_RESET_FLOOR) autoCompactArmedRef.current = true;
    if (status !== 'ready' || runningTotal < ORCHESTRATOR_AUTO_COMPACT_THRESHOLD || autoCompactInFlightRef.current || !autoCompactArmedRef.current) return;
    if (hasQueuedOrchestratorSessionPrelude(repoPath)) return;
    autoCompactInFlightRef.current = true;
    autoCompactArmedRef.current = false;
    let started = false;
    const timer = window.setTimeout(() => {
      started = true;
      void (async () => {
        try {
          const payload = await requestCompaction(repoPath, runningTotal, messagesRef.current);
          if (!payload?.ok || !payload.applied || !Array.isArray(payload.transcript) || statusRef.current !== 'ready') {
            autoCompactArmedRef.current = true;
            return;
          }
          await primeCompactedSession(repoPath, payload);
        } catch {
          autoCompactArmedRef.current = true;
        } finally {
          autoCompactInFlightRef.current = false;
        }
      })();
    }, 800);
    return () => {
      window.clearTimeout(timer);
      if (!started) autoCompactInFlightRef.current = false;
    };
  }, [primeCompactedSession, repoPath, requestCompaction, runningTotal, status]);

  // #539 — stall watchdog. If the UI stays in 'busy' state for > 5 minutes
  // without any events from the stream, the backend turn is almost certainly
  // dead even if the WS is still connected. Heal so the composer unlocks.
  useEffect(() => {
    if (!repoPath) return;

    const interval = setInterval(() => {
      if (statusRef.current !== 'busy') return;
      const quietFor = Date.now() - lastEventAtRef.current;
      if (quietFor >= HEAL_STALE_AFTER_MS) {
        healStaleBusyState(`no events for ${Math.round(quietFor / 1000)}s while status=busy`);
      }
    }, HEAL_POLL_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [repoPath, healStaleBusyState]);

  const compactNow = useCallback(async (_options?: { keepTailCount?: number; source?: 'manual' | 'handoff' }) => {
    const activeRepoPath = repoPathRef.current;
    if (!activeRepoPath) return null;
    const payload = await requestCompaction(activeRepoPath, runningTotalRef.current, messagesRef.current, {
      keepTailCount: _options?.keepTailCount,
      trigger: _options?.source ?? 'manual',
    });
    if (!payload?.ok) return null;
    if (!payload.applied || !Array.isArray(payload.transcript)) {
      return {
        applied: false,
        transcript: messagesRef.current,
        resumePrelude: null,
        tokensAfter: runningTotalRef.current,
      };
    }
    const primed = await primeCompactedSession(activeRepoPath, payload, { setTranscript: false });
    if (!primed) return null;
    return {
      applied: true,
      transcript: payload.transcript,
      resumePrelude: primed.resumePrelude,
      tokensAfter: primed.nextTotal,
    };
  }, [primeCompactedSession, requestCompaction]);

  const send = useCallback((message: string, options?: { permissionMode?: OrchestratorPermissionMode; thinkingEffort?: ThinkingEffort; model?: string }) => {
    if (!repoPathRef.current) return;

    const permissionMode: OrchestratorPermissionMode = options?.permissionMode ?? 'full';
    const thinkingEffort = options?.thinkingEffort;
    const model = options?.model?.trim() || DEFAULT_ORCHESTRATOR_MODEL;

    void (async () => {
      const activeRepoPath = repoPathRef.current;
      if (!activeRepoPath) return;
      const transcriptSnapshot = messagesRef.current;
      let planCaptureSource = transcriptSnapshot;
      const projectedTokens = estimateNextTurnTokens(message);
      if (projectedTokens >= ORCHESTRATOR_FORCE_COMPACT_THRESHOLD) {
        const compactingId = `orch-compacting-${Date.now()}`;
        const compactingAt = Date.now();
        statusRef.current = 'busy';
        setStatus('busy');
        setMessages((prev) => [...prev, {
          id: compactingId,
          role: 'system',
          text: 'Compacting to keep turn fast…',
          timestamp: compactingAt,
          timestampLabel: formatTimestampLabel(compactingAt),
        }]);
        try {
          const payload = await requestCompaction(activeRepoPath, runningTotalRef.current, transcriptSnapshot);
          const primed = payload ? await primeCompactedSession(activeRepoPath, payload, { setTranscript: false }) : null;
          const remaining = ORCHESTRATOR_COMPACTION_STATUS_MIN_MS - (Date.now() - compactingAt);
          if (remaining > 0) {
            await new Promise((resolve) => window.setTimeout(resolve, remaining));
          }
          if (!primed) {
            throw new Error(`Compaction failed before send. Re-send this message:\n\n${message}`);
          }
          if (!primed.resumePrelude) {
            throw new Error(`Compaction finished without a resume prelude. Re-send this message:\n\n${message}`);
          }
          const postCompactProjection = primed.nextTotal
            + ORCHESTRATOR_SYSTEM_PROMPT_ESTIMATE_TOKENS
            + ORCHESTRATOR_NEXT_TURN_BUFFER_TOKENS
            + approxTokens(message);
          if (postCompactProjection >= ORCHESTRATOR_FORCE_COMPACT_THRESHOLD) {
            clearQueuedOrchestratorSessionPrelude(activeRepoPath);
            throw new Error(`Context is still above the 85% safety cap after compaction. Re-send this message:\n\n${message}`);
          }
          planCaptureSource = primed.transcript;
          setMessages(primed.transcript);
        } catch (error) {
          setMessages((prev) => [
            ...prev.filter((entry) => entry.id !== compactingId),
            {
              id: `orch-compacting-error-${Date.now()}`,
              role: 'system',
              text: error instanceof Error ? error.message : `Compaction failed before send. Re-send this message:\n\n${message}`,
              timestamp: Date.now(),
              timestampLabel: formatTimestampLabel(Date.now()),
            },
          ]);
          statusRef.current = connected ? 'ready' : 'connecting';
          setStatus(connected ? 'ready' : 'connecting');
          return;
        }
      }
      const userEntry: MobileTranscriptEntry = {
        id: `orch-user-${Date.now()}`,
        role: 'user',
        text: message,
        timestamp: Date.now(),
        timestampLabel: formatTimestampLabel(Date.now()),
      };
      messagesRef.current = [...messagesRef.current, userEntry];
      setMessages((prev) => [...prev, userEntry]);
      currentAssistantRef.current = null;
      captureFirstTurnPlanRef.current = !planTextRef.current
        && !hasHistoryRef.current
        && !planCaptureSource.some((entry) => entry.role === 'assistant' || entry.role === 'system' || entry.role === 'tool');
      firstTurnPlanStartedRef.current = false;
      firstTurnPlanChunksRef.current = [];
      statusRef.current = 'busy';
      setStatus('busy');

      let outboundMessage = message;
      const resumePrelude = consumeOrchestratorSessionPrelude(activeRepoPath);
      if (resumePrelude) {
        outboundMessage = `${resumePrelude}\n\nOperator message:\n${message}`;
      }
      const payload = JSON.stringify({
        type: 'orchestrator-send',
        repoPath: activeRepoPath,
        message: outboundMessage,
        permissionMode,
        ...(thinkingEffort && thinkingEffort !== 'adaptive' ? { thinkingEffort } : {}),
        model,
      });
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(payload);
        return;
      }
      console.warn('[orchestrator-stream] WS not open, attempting reconnect...');
      connect();
      const waitAndSend = setInterval(() => {
        const currentWs = wsRef.current;
        if (currentWs?.readyState === WebSocket.OPEN) {
          clearInterval(waitAndSend);
          currentWs.send(payload);
        }
      }, 200);
      setTimeout(() => clearInterval(waitAndSend), 5000);
    })();
  }, [connect, connected, estimateNextTurnTokens, primeCompactedSession, requestCompaction]);

  return {
    messages,
    planText,
    status,
    busyState,
    tokenCount,
    runningTotal,
    estimateNextTurnTokens,
    send,
    appendLocalEntries,
    replaceTranscript,
    fetchTelemetrySnapshot: async () => (
      await refreshTokenTelemetry() ?? { totalTokens: runningTotalRef.current, estimatedCostUsd: null, model: null }
    ),
    compactNow,
    reset,
    connected,
  };
}
