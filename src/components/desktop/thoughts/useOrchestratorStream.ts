'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  MobileTranscriptEntry,
  MobileTranscriptToolLaunchLink,
} from '@/lib/mobile/types';
import { extractPlanFromTranscript } from '@/lib/llm/plan-extractor';
import { isMeteredOrchestratorBackend } from '@/lib/lane/orchestrator-backends/billing';
import { isOrchestratorBackendId, type OrchestratorBackendId } from '@/lib/lane/orchestrator-backends/types';
import {
  clearQueuedOrchestratorSessionPrelude,
  consumeOrchestratorSessionPrelude,
  hasQueuedOrchestratorSessionPrelude,
  subscribeOrchestratorMissionCompleted,
  type OrchestratorMissionCompletedDetail,
} from '@/lib/orchestrator/store';
import type { ThinkingEffort } from '@/lib/orchestrator/thinking-effort';
import type { OrchestratorExecutionMode } from '@/lib/orchestrator/types';
import type { ThoughtsOrchestratorBusyState } from '@/components/desktop/thoughts/chat-panel/types';
import {
  createOrchestratorClientMessageId,
  deliverOrchestratorPayload,
  type PendingOrchestratorSend,
} from './use-orchestrator-stream/delivery';
import { useDurablePendingSend } from './use-orchestrator-stream/durable-pending-send';
import { archiveMissionThread as archiveCompletedMissionThread } from './use-orchestrator-stream/mission-history';
import {
  primeCompactedOrchestratorSession,
  refreshOrchestratorTokenTelemetry,
  requestOrchestratorCompaction,
} from './use-orchestrator-stream/session';
import {
  appendSnapshotTurnFailure,
  useNoSnapshotBusyFallback,
} from './use-orchestrator-stream/snapshot-reconcile';
import {
  DEFAULT_ORCHESTRATOR_MODEL,
  ORCHESTRATOR_AUTO_COMPACT_RESET_FLOOR,
  ORCHESTRATOR_AUTO_COMPACT_THRESHOLD,
  ORCHESTRATOR_COMPACTION_STATUS_MIN_MS,
  ORCHESTRATOR_FORCE_COMPACT_THRESHOLD,
  ORCHESTRATOR_METERED_AUTO_COMPACT_RESET_FLOOR,
  ORCHESTRATOR_METERED_AUTO_COMPACT_THRESHOLD,
  ORCHESTRATOR_NEXT_TURN_BUFFER_TOKENS,
  ORCHESTRATOR_SYSTEM_PROMPT_ESTIMATE_TOKENS,
  approxTokens,
  createIdleBusyState,
  emitTokenUsage,
  formatTimestampLabel,
  getWsUrl,
  normalizeRepoPath,
  refreshWsCredentials,
  sortTranscriptEntries,
  type OrchestratorPermissionMode,
  type OrchestratorStreamStatus,
} from './use-orchestrator-stream/shared';
import {
  createOrchestratorMessageHandler,
  type CurrentAssistantStreamState,
  type OrchestratorSnapshotTurn,
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

// Mission ids whose completed-thread rotation already ran this app session —
// module-level so remounts (tab flaps) can't re-rotate a mission whose
// completion event re-fires from boot-time state oscillation.
const rotatedMissionIds = new Set<string>();

interface OrchestratorStreamResult {
  messages: MobileTranscriptEntry[];
  planText: string | null;
  status: OrchestratorStreamStatus;
  busyState: ThoughtsOrchestratorBusyState;
  tokenCount: number;
  runningTotal: number;
  estimateNextTurnTokens: (message: string) => number;
  send: (message: string, options?: OrchestratorSendOptions) => void;
  interrupt: () => void;
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
  retryPendingSend: (clientMessageId: string) => void;
  connected: boolean;
}

interface OrchestratorSendOptions {
  permissionMode?: OrchestratorPermissionMode;
  backend?: OrchestratorBackendId;
  thinkingEffort?: ThinkingEffort;
  model?: string;
  /**
   * Text shown in the transcript for the user's turn. The outbound `message`
   * can be a structured dispatcher prompt while the visible chat stays clean.
   */
  displayMessage?: string;
  /** Local system/command entries inserted immediately after the user bubble. */
  localEntriesAfterUser?: MobileTranscriptEntry[];
  /** Canonical per-turn dispatch policy shared with the canvas composer. */
  orchestrationMode?: OrchestratorExecutionMode;
  /**
   * Collide / MoA mode. When true, the turn routes to the `collide` backend:
   * Claude + Codex propose independently (read-only), Claude synthesizes + does
   * the work. Forces `backend: 'collide'` on the outbound payload; the swarm
   * directive is NOT applied (Collide is its own fusion).
   */
  collide?: boolean;
  /**
   * Composer picture pills. ThoughtsChatPanel has always passed these; the
   * wire silently dropped them until 2026-06-12 — now they ride the
   * orchestrator-send payload and reach the model as image blocks.
   */
  attachments?: Array<{ dataUri: string; name?: string }>;
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
  options?: {
    seededPlanText?: string | null;
    hasHistory?: boolean;
    threadId?: string | null;
    /**
     * Called when the hook synchronously mints a threadId inside `send()`
     * because the parent hasn't supplied one yet (first-message-on-empty-tab
     * path). The parent MUST update its own threadId state in response so the
     * next render keeps both sides aligned. Without this, ws-server's
     * `isThreadBacked` guard skips assistant-message persistence and the reply
     * silently drops on reload. See bug investigation 2026-05-27.
     */
    onThreadIdMint?: (threadId: string) => void;
    /** Requests a same-thread history refresh when server turn truth says a
     * settled assistant message is missing from the visible transcript. */
    onSettledAssistantMissing?: (assistantMessageId: string) => void;
  },
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
  // Highest orchestrator event seq applied for the current session view —
  // drives the replay `since` cursor + client-side de-dup (see socket.ts).
  const lastSeqRef = useRef(0);
  // rAF handle coalescing streaming-text flushes — see scheduleFlushCurrentAssistant.
  const flushFrameRef = useRef<number | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tokenRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const telemetrySessionKeyRef = useRef<string | null>(null);
  const telemetryTotalRef = useRef<number | null>(null);
  const statusRef = useRef(status);
  statusRef.current = status;
  const repoPathRef = useRef(repoPath);
  repoPathRef.current = repoPath;
  const threadId = options?.threadId ?? null;
  const threadIdRef = useRef<string | null>(threadId);
  // Only mirror the parent-supplied threadId when it is set. If the hook has
  // already minted an id inside send() (because the parent's state hadn't
  // landed yet), don't wipe it on the next render — the parent's eventual
  // setThreadId call will replace it with the same value via onThreadIdMint.
  if (threadId) threadIdRef.current = threadId;
  const onThreadIdMintRef = useRef(options?.onThreadIdMint);
  onThreadIdMintRef.current = options?.onThreadIdMint;
  const onSettledAssistantMissingRef = useRef(options?.onSettledAssistantMissing);
  onSettledAssistantMissingRef.current = options?.onSettledAssistantMissing;
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
  // Fable Slice 4 — last backend id seen on the stream (socket.ts stamps it
  // from every event). Read by the auto-compact effect to pick the metered
  // window target vs the global one.
  const lastBackendRef = useRef<string | null>(null);
  // Per-turn override used for backend-scoped subscribe + interrupt messages.
  // It must be set before the send ACK because the operator can press Stop
  // while the selected backend is still resolving its CLI (#1557).
  const activeTurnBackendRef = useRef<OrchestratorBackendId | null>(null);
  const missionRotationInFlightRef = useRef(false);
  const pendingMissionCompletionRef = useRef<OrchestratorMissionCompletedDetail | null>(null);
  const transitionStripTimerRef = useRef<number | null>(null);
  const pendingSendWatchdogRef = useRef<PendingOrchestratorSend | null>(null);
  const pendingActivityHandlerRef = useRef<(event: {
    event: string;
    data?: Record<string, unknown>;
    observedAt: number;
  }) => void>(() => {});

  // Server turn truth on subscribe snapshots is the primary reconciliation
  // seam. These elapsed/event refs remain only as a compatibility fallback
  // when a subscription receives no snapshot at all.
  const eventCountRef = useRef(0);
  const snapshotSeenRef = useRef(false);
  const turnTranscriptEventCountRef = useRef(0);
  const lastEventAtRef = useRef<number>(Date.now());
  // Wall-clock of the most recent local send(). The 3s reconnect heal uses this
  // to avoid clearing a freshly-started turn's "busy" state: a send that fired
  // after the socket opened means the turn is legitimately starting (and may be
  // cold-starting the orchestrator before its first event), not stale carryover.
  const lastSendAtRef = useRef(0);
  const RECONNECT_HEAL_DELAY_MS = 3000;
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

    const nextPlanText = extractPlanFromTranscript([{
      role: 'assistant',
      text: firstTurnPlanChunksRef.current.join(''),
    }]);
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
      threadId: threadIdRef.current,
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
    lastSeqRef.current = 0;
    activeTurnBackendRef.current = null;
    turnTranscriptEventCountRef.current = 0;
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
    if (pendingSendWatchdogRef.current) {
      window.clearTimeout(pendingSendWatchdogRef.current.timeoutId);
      pendingSendWatchdogRef.current = null;
    }
    clearQueuedOrchestratorSessionPrelude(repoPathRef.current, threadIdRef.current);
    emitTokenUsage({ repoPath: repoPathRef.current, tokenCount: 0, runningTotal: 0 });
  }, [connected, resetFirstTurnPlanCapture, syncMessages, updateRunningTotal]);

  const archiveMissionThread = useCallback(async (detail: OrchestratorMissionCompletedDetail) => {
    const activeRepoPath = repoPathRef.current;
    if (!activeRepoPath) return;
    await archiveCompletedMissionThread(detail, {
      planText: planTextRef.current,
      replaceTranscript,
      getTranscript: () => messagesRef.current,
      repoPath: activeRepoPath,
      reset,
      transcript: messagesRef.current,
      transitionStripTimerRef,
    });
  }, [replaceTranscript, reset]);

  const rotateMissionThread = useCallback(async (detail: OrchestratorMissionCompletedDetail) => {
    const activeRepoPath = normalizeRepoPath(repoPathRef.current);
    const eventRepoPath = normalizeRepoPath(detail.repoPath);
    if (!activeRepoPath || (eventRepoPath && eventRepoPath !== activeRepoPath)) {
      return;
    }
    // A mission completes ONCE — rotate at most once per missionId per app
    // session. The completed event re-fires when mission state oscillates
    // non-terminal→terminal on boot (WS reconnect / incremental packet load);
    // without this, a re-fire against a RESTORED transcript archived and
    // deleted the live thread again (the 2026-07-14 storm's second casualty).
    const missionId = detail.missionId?.trim();
    if (missionId && rotatedMissionIds.has(missionId)) return;
    if (missionRotationInFlightRef.current) {
      // Stash WITHOUT marking — the drain re-enters here and must pass the
      // dedupe; duplicate storms of the same id collapse on the check above.
      pendingMissionCompletionRef.current = detail;
      return;
    }
    if (missionId) rotatedMissionIds.add(missionId);

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

  // Clear stale local running state after authoritative server reconciliation
  // (or the no-snapshot compatibility fallback). Idempotent — safe to call
  // when nothing needs healing.
  const healStaleBusyState = useCallback((reason: string) => {
    const hasStaleStatus = statusRef.current === 'busy';
    const hasOrphanAssistant = currentAssistantRef.current !== null;
    const hasActiveTurn = activeTurnRef.current !== null;
    const hasRunningTools = messagesRef.current.some((m) =>
      m.toolCalls?.some((t) => t.status === 'running'),
    );
    if (!hasStaleStatus && !hasOrphanAssistant && !hasActiveTurn && !hasRunningTools) return;

    console.warn(`[orchestrator-stream] Healing stale busy state: ${reason}`);
    if (hasStaleStatus) {
      statusRef.current = 'ready';
      setStatus('ready');
    }
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

  const reconcileSnapshotTerminalTurn = useCallback((
    turn: OrchestratorSnapshotTurn | null,
    wasRunning: boolean,
  ) => {
    const wasLocallyRunning = wasRunning || activeTurnRef.current !== null;
    healStaleBusyState(turn
      ? `server turn ${turn.id} settled (${turn.outcome ?? 'unknown outcome'})`
      : 'server reports no turn for this thread');
    if (!wasLocallyRunning || turn?.outcome !== 'failed') return;

    appendSnapshotTurnFailure(turn.id, setMessages, messagesRef);
  }, [healStaleBusyState]);

  const settlePendingSend = useCallback((event: {
    event: string;
    data?: Record<string, unknown>;
    observedAt: number;
  }) => {
    pendingActivityHandlerRef.current(event);
  }, []);

  const flushCurrentAssistant = useCallback(() => {
    // An immediate flush supersedes any queued frame — cancel it so a late
    // frame can't fire a redundant setMessages after a terminal flush.
    if (flushFrameRef.current !== null) {
      if (typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(flushFrameRef.current);
      flushFrameRef.current = null;
    }
    const current = currentAssistantRef.current;
    if (!current || (current.chunks.length === 0 && current.thinkingChunks.length === 0)) return;

    // Token-streaming backends (verbatimStream) send slices of one continuous
    // string — concatenate verbatim. Block-emitting backends (Claude REPL,
    // Codex items) send complete segments that need the '\n' glue.
    const joiner = current.verbatimStream ? '' : '\n';
    const text = current.chunks.join(joiner);
    const thinking = current.thinkingChunks.length > 0 ? current.thinkingChunks.join(joiner) : undefined;
    // Reasoning-phase fields (see CurrentAssistantStreamState): the frozen
    // duration drives the "Thought for Ns" line; `thinkingActive` stays true
    // only while reasoning is still the ONLY thing that has happened.
    const thinkingDurationMs = current.thinkingDurationMs ?? undefined;
    const thinkingActive = current.thinkingStartedAt != null && current.thinkingDurationMs == null
      && current.chunks.length === 0;
    setMessages(prev => {
      const idx = prev.findIndex(m => m.id === current.id);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = {
          ...next[idx],
          text: text || (thinking ? '' : ''),
          thinking,
          ...(thinkingDurationMs !== undefined ? { thinkingDurationMs } : {}),
          thinkingActive,
          timestamp: next[idx].timestamp ?? Date.now(),
          timestampLabel: next[idx].timestampLabel ?? formatTimestampLabel(Date.now()),
        };
        messagesRef.current = next;
        return next;
      }
      const assistantEntry: MobileTranscriptEntry = {
        id: current.id,
        role: 'assistant',
        text: text || (thinking ? '' : ''),
        thinking,
        ...(thinkingDurationMs !== undefined ? { thinkingDurationMs } : {}),
        thinkingActive,
        timestamp: Date.now(),
        timestampLabel: formatTimestampLabel(Date.now()),
      };
      const next = [...prev, assistantEntry];
      messagesRef.current = next;
      return next;
    });
  }, []);

  // Coalesced flush for the streaming-text path: at most one setMessages per
  // animation frame (≤60fps) regardless of delta rate. Each delta used to fire
  // its own flush — a full re-render + markdown re-parse per token — which made
  // streaming choppy and starved the WS read loop, letting backpressure drop
  // narration between tool pills. Terminal flushes (turn 'ready', heal) still
  // call flushCurrentAssistant directly for a synchronous final paint. 2026-06-17.
  const scheduleFlushCurrentAssistant = useCallback(() => {
    if (flushFrameRef.current !== null) return;
    if (typeof requestAnimationFrame === 'undefined') {
      flushCurrentAssistant();
      return;
    }
    flushFrameRef.current = requestAnimationFrame(() => {
      flushFrameRef.current = null;
      flushCurrentAssistant();
    });
  }, [flushCurrentAssistant]);

  const connect = useCallback(() => {
    if (!repoPathRef.current) return;
    if (wsRef.current?.readyState === WebSocket.OPEN || wsRef.current?.readyState === WebSocket.CONNECTING) return;
    const wsUrl = getWsUrl();
    if (!wsUrl) return;

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;
    // Distinguishes "connection dropped" from "handshake never succeeded" —
    // the latter means our baked credentials are stale (app restarted under
    // this page) and the reconnect must refresh them first.
    let everOpened = false;

    ws.onopen = () => {
      everOpened = true;
      setConnected(true);
      snapshotSeenRef.current = false;
      // Don't clobber a live turn's "busy" on a mid-turn reconnect. Downgrading
      // to 'connecting' here made the working indicator (and the streaming reply,
      // via socket.ts's currentAssistant guard) vanish on a network flap. A
      // genuinely stale busy is reconciled by the subscribe snapshot's turn
      // ledger, with the elapsed fallback reserved for no-snapshot servers.
      setStatus(statusRef.current === 'busy' ? 'busy' : 'connecting');

      // Subscribe to orchestrator channel
      ws.send(JSON.stringify({
        type: 'orchestrator-subscribe',
        repoPath: repoPathRef.current,
        ...(threadIdRef.current ? { threadId: threadIdRef.current } : {}),
        ...(activeTurnBackendRef.current ? { backend: activeTurnBackendRef.current } : {}),
        // Replay anything we missed since the last event we applied — on a
        // reconnect mid-turn this recovers the in-flight tokens instead of
        // leaving us stuck on a "Working" pill with no stream.
        since: lastSeqRef.current,
      }));

      console.log('[orchestrator-stream] Connected, subscribing...');

      // Reconnect compatibility heal. If this is a fresh connect, status is already
      // 'connecting' and the heal is a no-op. If we're reconnecting after a
      // ws-server restart or a network flap, any "busy" state we carried over
      // is potentially stale. Give the server 3 seconds to push events for a
      // genuinely active turn; if nothing arrives, clear the stale indicators.
      const countAtOpen = eventCountRef.current;
      const openedAt = Date.now();
      setTimeout(() => {
        if (ws !== wsRef.current) return;
        if (snapshotSeenRef.current) return;
        if (eventCountRef.current !== countAtOpen) return;
        // A send fired after this socket opened → the busy is fresh (the
        // orchestrator may still be cold-starting before its first event), not
        // stale carryover. Leave it; server turn truth is the backstop.
        if (lastSendAtRef.current >= openedAt) return;
        if (statusRef.current === 'busy' || currentAssistantRef.current) {
          healStaleBusyState('reconnect with no follow-up events after 3s');
        }
      }, RECONNECT_HEAL_DELAY_MS);
    };

    ws.onmessage = createOrchestratorMessageHandler({
      captureFirstTurnPlanRef,
      activeTurnBackendRef,
      currentWs: ws,
      currentAssistantRef,
      eventCountRef,
      snapshotSeenRef,
      threadIdRef,
      finalizeFirstTurnPlanCapture,
      firstTurnPlanChunksRef,
      firstTurnPlanStartedRef,
      flushCurrentAssistant,
      scheduleFlushCurrentAssistant,
      lastBackendRef,
      lastSeqRef,
      lastEventAtRef,
      messagesRef,
      onOrchestratorActivity: settlePendingSend,
      onSnapshotTurnTerminal: reconcileSnapshotTerminalTurn,
      onSettledAssistantMissing: (turn) => {
        if (turn.assistantMessageId) {
          onSettledAssistantMissingRef.current?.(turn.assistantMessageId);
        }
      },
      resetEpochRef,
      setMessages,
      setStatus,
      statusRef,
      turnTranscriptEventCountRef,
      wsRef,
    });

    ws.onclose = () => {
      setConnected(false);
      wsRef.current = null;
      console.log('[orchestrator-stream] Disconnected');

      // Auto-reconnect after 2s — but only if still mounted. A close WITHOUT a
      // successful open means the handshake was rejected — the page's baked
      // token/port are stale (app restarted underneath us, live-hit
      // 2026-07-12) — so pull fresh credentials before the retry instead of
      // failing identically forever until a manual reload.
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (!mountedRef.current) return;
      const refresh = everOpened ? Promise.resolve(false) : refreshWsCredentials();
      reconnectTimerRef.current = setTimeout(() => {
        void refresh.then(() => {
          if (repoPathRef.current && mountedRef.current) connect();
        });
      }, 2000);
    };

    ws.onerror = () => {
      // onclose will fire after this
    };
  }, [finalizeFirstTurnPlanCapture, flushCurrentAssistant, scheduleFlushCurrentAssistant, healStaleBusyState, reconcileSnapshotTerminalTurn, settlePendingSend]);

  const setPendingStatusReady = useCallback(() => {
    const nextStatus = wsRef.current?.readyState === WebSocket.OPEN || connected ? 'ready' : 'connecting';
    statusRef.current = nextStatus;
    setStatus(nextStatus);
    setBusyState(createIdleBusyState());
    activeTurnRef.current = null;
    currentAssistantRef.current = null;
    resetFirstTurnPlanCapture();
  }, [connected, resetFirstTurnPlanCapture]);
  const setPendingStatusBusy = useCallback(() => {
    statusRef.current = 'busy';
    setStatus('busy');
  }, []);
  const durablePendingSend = useDurablePendingSend({
    repoPath, threadId, pendingRef: pendingSendWatchdogRef, messagesRef, setMessages,
    getWebSocket: () => wsRef.current, connect,
    setStatusBusy: setPendingStatusBusy, setStatusReady: setPendingStatusReady,
  });
  pendingActivityHandlerRef.current = durablePendingSend.observeActivity;

  useEffect(() => {
    if (!repoPath || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    // repoPath/threadId changed → this is a new session view (e.g. the
    // first-turn threadId mint, which re-subscribes onto the turn's real
    // session). Reset the replay cursor and ask for the whole in-flight turn so
    // a clobbered/raced status can't leave us with no stream.
    lastSeqRef.current = 0;
    snapshotSeenRef.current = false;
    wsRef.current.send(JSON.stringify({
      type: 'orchestrator-subscribe',
      repoPath,
      ...(threadId ? { threadId } : {}),
      ...(activeTurnBackendRef.current ? { backend: activeTurnBackendRef.current } : {}),
      since: 0,
    }));
  }, [repoPath, threadId]);

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
      if (flushFrameRef.current !== null) {
        if (typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(flushFrameRef.current);
        flushFrameRef.current = null;
      }
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
      if (pendingSendWatchdogRef.current) {
        window.clearTimeout(pendingSendWatchdogRef.current.timeoutId);
        pendingSendWatchdogRef.current = null;
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
    // Fable Slice 4 — a metered backend compacts at the ~15K window target;
    // subscription backends keep the global 300K. Cache-aware: this effect only
    // fires at status==='ready' (the between-turn boundary), so a compaction —
    // which rewrites the prompt-cache prefix at one full-price re-read — never
    // lands mid-stride. Keyed to the billing class, not the backend name.
    const metered = lastBackendRef.current !== null
      && isOrchestratorBackendId(lastBackendRef.current)
      && isMeteredOrchestratorBackend(lastBackendRef.current);
    const resetFloor = metered ? ORCHESTRATOR_METERED_AUTO_COMPACT_RESET_FLOOR : ORCHESTRATOR_AUTO_COMPACT_RESET_FLOOR;
    const threshold = metered ? ORCHESTRATOR_METERED_AUTO_COMPACT_THRESHOLD : ORCHESTRATOR_AUTO_COMPACT_THRESHOLD;
    if (runningTotal < resetFloor) autoCompactArmedRef.current = true;
    if (status !== 'ready' || runningTotal < threshold || autoCompactInFlightRef.current || !autoCompactArmedRef.current) return;
    if (hasQueuedOrchestratorSessionPrelude(repoPath, threadIdRef.current)) return;
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
          // setTranscript:false — auto-compaction is a SILENT background op: it
          // compacts the server session but must NOT replace the visible
          // transcript, or it wipes ephemeral entries (the Collide "N proposals
          // collided" card, system notes) that live only in the client array.
          // Matches the two send-flow compaction call sites, which already pass
          // false; this path was the lone outlier that dropped the Collide card
          // on a later turn.
          await primeCompactedSession(repoPath, payload, { setTranscript: false });
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

  useNoSnapshotBusyFallback({
    repoPath, snapshotSeenRef, statusRef, lastEventAtRef,
    turnTranscriptEventCountRef, messagesRef, setMessages, healStaleBusyState,
  });

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

  // #624 — User clicked the stop pill. Fire-and-forget the interrupt message
  // to ws-server and optimistically flip status back to ready/connecting so
  // the composer unlocks immediately. The server's abort path emits a normal
  // 'done' event within 1-2s which reinforces the idle state. Partial events
  // already accumulated in the transcript stay intact.
  const interrupt = useCallback(() => {
    const activeRepoPath = repoPathRef.current;
    if (!activeRepoPath) return;
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'orchestrator-interrupt',
        repoPath: activeRepoPath,
        ...(threadIdRef.current ? { threadId: threadIdRef.current } : {}),
        ...(activeTurnBackendRef.current ? { backend: activeTurnBackendRef.current } : {}),
      }));
    }
    if (statusRef.current === 'busy') {
      const nextStatus = connected ? 'ready' : 'connecting';
      statusRef.current = nextStatus;
      setStatus(nextStatus);
      setBusyState(createIdleBusyState());
      activeTurnRef.current = null;
      currentAssistantRef.current = null;
    }
  }, [connected]);

  const send = useCallback((message: string, options?: OrchestratorSendOptions) => {
    if (!repoPathRef.current) {
      // No workspace selected — the orchestrator has nothing to act on. Surface
      // a guiding notice instead of silently dropping the message: the caller
      // already cleared the composer, so a bare return makes the message vanish
      // (the "I typed and nothing happened" fresh-user trap). De-duped so
      // repeated sends don't stack identical notices.
      const at = Date.now();
      setMessages((prev) => (
        prev.some((m) => m.id.startsWith('orch-no-repo'))
          ? prev
          : [...prev, {
              id: `orch-no-repo-${at}`,
              role: 'system',
              text: 'No repo selected yet — the orchestrator works inside a repo. Add one (the “Add a repo” button above, or the project chip below the composer), then send again.',
              timestamp: at,
              timestampLabel: formatTimestampLabel(at),
            }]
      ));
      return;
    }

    const permissionMode: OrchestratorPermissionMode = options?.permissionMode ?? 'full';
    const thinkingEffort = options?.thinkingEffort;
    const model = options?.model?.trim() || DEFAULT_ORCHESTRATOR_MODEL;
    const displayMessage = options?.displayMessage?.trim() || message;
    const localEntriesAfterUser = options?.localEntriesAfterUser ?? [];
    const requestedOrchestrationMode = options?.orchestrationMode ?? 'fleet';
    // Single is the hard boundary: even a stale UI state that still has MoA
    // armed must not route into Collide's proposer fan-out.
    const collide = options?.collide === true && requestedOrchestrationMode !== 'single';
    const collideBaseBackend = collide ? options?.backend : undefined;
    const backend = collide ? 'collide' : options?.backend;
    activeTurnBackendRef.current = requestedOrchestrationMode === 'single'
      ? 'codex'
      : backend ?? null;
    // Collide owns its proposal/aggregation pass; the separate Fusion directive
    // would nest a second fan-out inside it.
    const orchestrationMode: OrchestratorExecutionMode = collide
      ? 'fleet'
      : requestedOrchestrationMode;

    void (async () => {
      const activeRepoPath = repoPathRef.current;
      if (!activeRepoPath) {
        activeTurnBackendRef.current = null;
        return;
      }
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
            clearQueuedOrchestratorSessionPrelude(activeRepoPath, threadIdRef.current);
            throw new Error(`Context is still above the 85% safety cap after compaction. Re-send this message:\n\n${message}`);
          }
          planCaptureSource = primed.transcript;
          setMessages(primed.transcript);
        } catch (error) {
          activeTurnBackendRef.current = null;
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
      const clientMessageId = createOrchestratorClientMessageId();
      const sentAtMs = Date.now();
      const userEntry: MobileTranscriptEntry = {
        id: `orch-user-${clientMessageId}`,
        role: 'user',
        text: displayMessage,
        timestamp: sentAtMs,
        timestampLabel: formatTimestampLabel(sentAtMs),
      };
      messagesRef.current = [...messagesRef.current, userEntry, ...localEntriesAfterUser];
      setMessages((prev) => [...prev, userEntry, ...localEntriesAfterUser]);
      currentAssistantRef.current = null;
      captureFirstTurnPlanRef.current = !planTextRef.current
        && !hasHistoryRef.current
        && !planCaptureSource.some((entry) => entry.role === 'assistant' || entry.role === 'system' || entry.role === 'tool');
      firstTurnPlanStartedRef.current = false;
      firstTurnPlanChunksRef.current = [];

      // Mint a threadId synchronously if the parent's state hasn't landed
      // yet. ws-server uses `threadId.startsWith('thoughts-')` to decide
      // whether to persist the assistant reply — without an id here, the
      // turn streams to the open client but never lands in
      // ~/.o8/chat-history/<id>.json, so a reload shows the user message
      // alone with no reply. Notify the parent so its `threadId` state
      // catches up on the next render.
      if (!threadIdRef.current) {
        const minted = `thoughts-${Date.now()}`;
        threadIdRef.current = minted;
        try { onThreadIdMintRef.current?.(minted); } catch { /* parent owns the consequence */ }
      }
      let outboundMessage = message;
      const resumePrelude = consumeOrchestratorSessionPrelude(activeRepoPath, threadIdRef.current);
      if (resumePrelude) {
        outboundMessage = `${resumePrelude}\n\nOperator message:\n${message}`;
      }
      turnTranscriptEventCountRef.current = 0;
      const payload = JSON.stringify({
        type: 'orchestrator-send',
        repoPath: activeRepoPath,
        ...(threadIdRef.current ? { threadId: threadIdRef.current } : {}),
        clientMessageId,
        message: outboundMessage,
        // What the TRANSCRIPT stores/shows — the user's own words, never the
        // mode directives or resume prelude baked into `message` for the model.
        displayMessage,
        permissionMode,
        orchestrationMode,
        ...(thinkingEffort && thinkingEffort !== 'adaptive' ? { thinkingEffort } : {}),
        model,
        // Per-turn backend override keeps the composer chip truthful even while
        // the global operator default write is still settling.
        ...(backend ? { backend } : {}),
        ...(collideBaseBackend ? { collideBaseBackend } : {}),
        ...(options?.attachments?.length ? { attachments: options.attachments } : {}),
      });
      const pendingRecord = {
        text: outboundMessage,
        displayMessage,
        threadId: threadIdRef.current!,
        clientMessageId,
        sentAtMs,
        wirePayload: payload,
      };
      durablePendingSend.recordPending(pendingRecord);
      const delivered = await deliverOrchestratorPayload({
        payload,
        getWebSocket: () => wsRef.current,
        connect: () => { console.warn('[orchestrator-stream] WS not open, attempting reconnect...'); connect(); },
      });

      if (!delivered) {
        activeTurnBackendRef.current = null;
        durablePendingSend.failPending(pendingRecord);
        return;
      }

      const deliveredAt = Date.now();
      lastSendAtRef.current = deliveredAt;
      lastEventAtRef.current = deliveredAt;
      durablePendingSend.armRecord(pendingRecord, deliveredAt);
      setPendingStatusBusy();
    })();
  }, [connect, connected, durablePendingSend, estimateNextTurnTokens, primeCompactedSession, requestCompaction, setPendingStatusBusy]);

  return {
    messages,
    planText,
    status,
    busyState,
    tokenCount,
    runningTotal,
    estimateNextTurnTokens,
    send,
    interrupt,
    appendLocalEntries,
    replaceTranscript,
    fetchTelemetrySnapshot: async () => (
      await refreshTokenTelemetry() ?? { totalTokens: runningTotalRef.current, estimatedCostUsd: null, model: null }
    ),
    compactNow,
    reset,
    retryPendingSend: (clientMessageId) => { void durablePendingSend.retryPending(clientMessageId); },
    connected,
  };
}
