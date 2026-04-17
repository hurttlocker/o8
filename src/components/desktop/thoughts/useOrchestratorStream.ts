'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  MobileTranscriptEntry,
  MobileTranscriptToolCall,
  MobileTranscriptToolLaunchLink,
} from '@/lib/mobile/types';
import { getBrowserWsPort } from '@/lib/panel/ws-port-client';
import type { ThoughtsOrchestratorBusyState } from '@/components/desktop/thoughts/chat-panel/types';

export type OrchestratorStreamStatus = 'connecting' | 'ready' | 'busy' | 'error' | 'dead';

export type OrchestratorPermissionMode = 'full' | 'plan';

interface OrchestratorStreamResult {
  messages: MobileTranscriptEntry[];
  planText: string | null;
  status: OrchestratorStreamStatus;
  busyState: ThoughtsOrchestratorBusyState;
  tokenCount: number;
  runningTotal: number;
  send: (message: string, options?: { permissionMode?: OrchestratorPermissionMode; thinkingEffort?: 'medium' | 'high' | 'max' }) => void;
  reset: () => void;
  connected: boolean;
}

let agentUpdateSeq = 0;
const ORCHESTRATOR_CONTEXT_LIMIT = 1_000_000;
export const ORCHESTRATOR_TOKEN_EVENT = 'cortex:orchestrator-token-usage';

export interface OrchestratorTokenUsageDetail {
  repoPath: string | null;
  tokenCount: number;
  runningTotal: number;
}

function getWsUrl(): string {
  if (typeof window === 'undefined') return '';
  const { hostname, port, protocol } = window.location;
  const token = document.querySelector('meta[name="ws-token"]')?.getAttribute('content') ?? '';
  const isLocal = hostname === 'localhost' || hostname === '127.0.0.1';
  const wsProto = protocol === 'https:' ? 'wss' : 'ws';

  if (isLocal) {
    return `ws://${hostname}:${getBrowserWsPort()}/ws?token=${encodeURIComponent(token)}`;
  }

  const wsPort = port ? `:${port}` : '';
  return `${wsProto}://${hostname}${wsPort}/ws?token=${encodeURIComponent(token)}`;
}

function normalizeTelemetryPath(value: string | null | undefined): string {
  return (value ?? '').trim().replace(/\/+$/, '').replace(/^~(?=\/)/, '');
}

function scoreTelemetryPath(candidate: string | null | undefined, repoPath: string): number {
  const normalizedCandidate = normalizeTelemetryPath(candidate);
  const normalizedRepo = normalizeTelemetryPath(repoPath);
  if (!normalizedCandidate || !normalizedRepo) return 0;
  if (normalizedCandidate === normalizedRepo) return 4;
  if (normalizedRepo.endsWith(normalizedCandidate) || normalizedCandidate.endsWith(normalizedRepo)) return 3;
  const candidateName = normalizedCandidate.split('/').filter(Boolean).pop();
  const repoName = normalizedRepo.split('/').filter(Boolean).pop();
  return candidateName && candidateName === repoName ? 1 : 0;
}

function emitTokenUsage(detail: OrchestratorTokenUsageDetail): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<OrchestratorTokenUsageDetail>(ORCHESTRATOR_TOKEN_EVENT, { detail }));
}

interface ActiveTurnState {
  startedAt: number;
  toolCallsStarted: number;
  toolCallsCompleted: number;
  latestToolLabel: string | null;
  launches: MobileTranscriptToolLaunchLink[];
}

function createIdleBusyState(): ThoughtsOrchestratorBusyState {
  return {
    active: false,
    startedAt: null,
    toolCallsStarted: 0,
    toolCallsCompleted: 0,
    latestToolLabel: null,
  };
}

function summarizeToolActivity(name: string, args?: Record<string, unknown>): string {
  const normalized = name.trim() || 'tool';
  const lower = normalized.toLowerCase();
  const read = (...values: unknown[]) => values.find((value) => typeof value === 'string' && value.trim()) as string | undefined;

  if (lower === 'exec' || lower === 'exec_command') {
    return read(args?.command, args?.cmd)?.trim() ?? normalized;
  }
  if (lower === 'cortex_launch_agent' || lower === 'mcp__cortex__cortex_launch_agent') {
    return read(args?.taskName, args?.task_name, args?.prompt)?.trim() ?? 'Launching agent';
  }
  if (lower === 'read_file' || lower === 'read') {
    return read(args?.file_path, args?.path)?.trim() ?? 'Reading file';
  }
  if (lower === 'search_web' || lower === 'web_search') {
    return read(args?.query, args?.q)?.trim() ?? 'Searching the web';
  }
  if (lower === 'list_files' || lower === 'glob' || lower === 'ls') {
    return read(args?.path, args?.pattern)?.trim() ?? 'Listing workspace files';
  }
  return read(args?.path, args?.file_path, args?.url, args?.query, args?.taskName, args?.prompt)?.trim() ?? normalized;
}

function normalizeLaunchLabel(taskName?: string | null, prompt?: string | null, surfaceId?: string | null): string {
  const issueRef = taskName?.match(/#\d+/)?.[0] ?? prompt?.match(/#\d+/)?.[0] ?? null;
  if (issueRef) {
    const suffix = taskName?.replace(/^.*?#\d+\s*/u, '').replace(/^[-:]\s*/, '').trim();
    return suffix ? `${issueRef} ${suffix}` : issueRef;
  }
  const label = taskName?.trim() || prompt?.trim() || surfaceId?.trim() || 'agent session';
  return label.length > 48 ? `${label.slice(0, 47)}…` : label;
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function buildLaunchLink(
  name: string,
  args: Record<string, unknown> | undefined,
  output: string,
): MobileTranscriptToolLaunchLink | null {
  const lower = name.toLowerCase();
  if (lower !== 'cortex_launch_agent' && lower !== 'mcp__cortex__cortex_launch_agent') {
    return null;
  }

  const payload = parseJsonObject(output);
  const ok = payload?.ok;
  const surfaceId = typeof payload?.surfaceId === 'string' ? payload.surfaceId : null;
  if (ok === false || !surfaceId) {
    return null;
  }

  return {
    surfaceId,
    repoPath: typeof payload?.worktreePath === 'string'
      ? payload.worktreePath
      : typeof args?.repoPath === 'string'
        ? args.repoPath
        : null,
    laneId: typeof payload?.laneId === 'string' ? payload.laneId : null,
    branch: typeof payload?.branch === 'string' ? payload.branch : null,
    worktreePath: typeof payload?.worktreePath === 'string' ? payload.worktreePath : null,
    label: normalizeLaunchLabel(
      typeof args?.taskName === 'string' ? args.taskName : null,
      typeof args?.prompt === 'string' ? args.prompt : null,
      surfaceId,
    ),
  };
}

function buildToolResultPreview(output: string): string | undefined {
  const payload = parseJsonObject(output);
  const note = typeof payload?.note === 'string' ? payload.note.trim() : '';
  if (note) return note.length > 160 ? `${note.slice(0, 159)}…` : note;
  const firstLine = output.split('\n').map((line) => line.trim()).find(Boolean) ?? '';
  return firstLine ? (firstLine.length > 160 ? `${firstLine.slice(0, 159)}…` : firstLine) : undefined;
}

function buildTurnAutoSummary(turn: ActiveTurnState | null): string | null {
  if (!turn) return null;
  if (turn.launches.length === 0) {
    return turn.toolCallsStarted > 0
      ? `Completed ${turn.toolCallsStarted} tool call${turn.toolCallsStarted === 1 ? '' : 's'}. No agents launched.`
      : null;
  }

  const launchSummary = turn.launches
    .map((launch) => `Launched ${launch.label}${launch.laneId ? ` (ref ${launch.laneId})` : ''}.`)
    .join(' ');

  if (turn.launches.length === 1) {
    return `${launchSummary} No other agents launched.`;
  }

  return `${launchSummary} ${turn.launches.length} agents launched total.`;
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
  const currentAssistantRef = useRef<{ id: string; chunks: string[]; thinkingChunks: string[] } | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tokenRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const telemetrySessionKeyRef = useRef<string | null>(null);
  const telemetryTotalRef = useRef<number | null>(null);
  const statusRef = useRef(status);
  statusRef.current = status;
  const repoPathRef = useRef(repoPath);
  repoPathRef.current = repoPath;
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

  const syncBusyState = useCallback(() => {
    const turn = activeTurnRef.current;
    if (!turn) {
      setBusyState(createIdleBusyState());
      return;
    }
    setBusyState({
      active: true,
      startedAt: turn.startedAt,
      toolCallsStarted: turn.toolCallsStarted,
      toolCallsCompleted: turn.toolCallsCompleted,
      latestToolLabel: turn.latestToolLabel,
    });
  }, []);

  const refreshTokenTelemetry = useCallback(async () => {
    const activeRepoPath = repoPathRef.current;
    if (!activeRepoPath) return;

    try {
      let sessionKey = telemetrySessionKeyRef.current;
      if (!sessionKey) {
        const inventoryResponse = await fetch('/api/runtime/inventory?fresh=1', { cache: 'no-store' });
        const inventory = inventoryResponse.ok
          ? await inventoryResponse.json() as {
            agents?: Array<{
              runtime?: string;
              sessionKey?: string;
              sessionKind?: string;
              status?: string;
              isCurrentSession?: boolean;
              workspace?: string;
              runtimeSurface?: { cwd?: string | null };
            }>;
          }
          : null;
        sessionKey = (inventory?.agents ?? [])
          .map((agent) => {
            if (agent.runtime !== 'claude-code' || !agent.sessionKey) return { score: -1, sessionKey: null as string | null };
            const pathScore = Math.max(
              scoreTelemetryPath(agent.workspace, activeRepoPath),
              scoreTelemetryPath(agent.runtimeSurface?.cwd, activeRepoPath),
            );
            if (pathScore === 0) return { score: -1, sessionKey: null as string | null };
            return {
              score: pathScore * 10
                + (agent.sessionKind === 'owned' ? 6 : 0)
                + (agent.isCurrentSession ? 3 : 0)
                + (agent.status === 'running' || agent.status === 'reviewing' || agent.status === 'idle' ? 1 : 0),
              sessionKey: agent.sessionKey,
            };
          })
          .sort((left, right) => right.score - left.score)[0]?.sessionKey ?? null;
        telemetrySessionKeyRef.current = sessionKey;
      }
      if (!sessionKey) return;

      const response = await fetch(`/api/runtime/telemetry?sessionKey=${encodeURIComponent(sessionKey)}`, { cache: 'no-store' });
      if (!response.ok) {
        telemetrySessionKeyRef.current = null;
        return;
      }

      const payload = await response.json() as { telemetry?: { totalTokens?: number | null } };
      const totalTokens = typeof payload.telemetry?.totalTokens === 'number'
        ? Math.max(0, Math.min(ORCHESTRATOR_CONTEXT_LIMIT, payload.telemetry.totalTokens))
        : null;
      if (totalTokens == null) return;

      const previousTotal = telemetryTotalRef.current;
      const nextTokenCount = previousTotal === null || totalTokens < previousTotal
        ? 0
        : Math.max(0, totalTokens - previousTotal);

      telemetryTotalRef.current = totalTokens;
      setTokenCount(nextTokenCount);
      setRunningTotal(totalTokens);
      emitTokenUsage({ repoPath: activeRepoPath, tokenCount: nextTokenCount, runningTotal: totalTokens });
    } catch {
      // silent
    }
  }, []);

  const beginTurn = useCallback(() => {
    if (!activeTurnRef.current) {
      activeTurnRef.current = {
        startedAt: Date.now(),
        toolCallsStarted: 0,
        toolCallsCompleted: 0,
        latestToolLabel: null,
        launches: [],
      };
    }
    syncBusyState();
  }, [syncBusyState]);

  const endTurn = useCallback(() => {
    activeTurnRef.current = null;
    setBusyState(createIdleBusyState());
  }, []);

  const appendAutoSummary = useCallback((summary: string | null) => {
    if (!summary) return;
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last?.role === 'assistant' && last.text.trim() === summary.trim()) {
        return prev;
      }
      return [
        ...prev,
        {
          id: `orch-summary-${Date.now()}`,
          role: 'assistant',
          text: summary,
          timestamp: Date.now(),
          timestampLabel: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        },
      ];
    });
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
          timestampLabel: next[idx].timestampLabel ?? new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        };
        return next;
      }
      return [...prev, {
        id: current.id,
        role: 'assistant',
        text: text || (thinking ? '' : ''),
        thinking,
        timestamp: Date.now(),
        timestampLabel: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      }];
    });
  }, []);

  const upsertToolCall = useCallback((toolCall: MobileTranscriptToolCall) => {
    if (!currentAssistantRef.current) {
      currentAssistantRef.current = {
        id: `orch-assistant-${Date.now()}`,
        chunks: [],
        thinkingChunks: [],
      };
    }

    const current = currentAssistantRef.current;
    setMessages((prev) => {
      const idx = prev.findIndex((message) => message.id === current.id);
      const baseEntry = idx >= 0
        ? prev[idx]
        : {
            id: current.id,
            role: 'assistant' as const,
            text: '',
            timestamp: Date.now(),
            timestampLabel: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          };
      const existingTools = baseEntry.toolCalls ?? [];
      const toolIndex = existingTools.findIndex((candidate) => (
        (toolCall.id && candidate.id === toolCall.id)
        || (!toolCall.id && candidate.name === toolCall.name && candidate.status !== 'done')
      ));
      const nextTools = toolIndex >= 0
        ? existingTools.map((candidate, index) => (
          index === toolIndex
            ? { ...candidate, ...toolCall, args: toolCall.args ?? candidate.args }
            : candidate
        ))
        : [...existingTools, toolCall];
      const nextEntry: MobileTranscriptEntry = {
        ...baseEntry,
        toolCalls: nextTools,
      };

      if (idx >= 0) {
        const next = [...prev];
        next[idx] = nextEntry;
        return next;
      }
      return [...prev, nextEntry];
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

    ws.onmessage = (event) => {
      // Ignore messages from a stale/closed connection (StrictMode double-mount race)
      if (ws !== wsRef.current) return;

      let msg: { channel?: string; event?: string; data?: Record<string, unknown> };
      try {
        msg = JSON.parse(typeof event.data === 'string' ? event.data : '');
      } catch {
        return;
      }

      if (msg.channel !== 'orchestrator') return;

      // #539 — signal liveness for the reconnect heal + stall watchdog.
      eventCountRef.current += 1;
      lastEventAtRef.current = Date.now();

      switch (msg.event) {
        case 'output': {
          const text = typeof msg.data?.text === 'string' ? msg.data.text : '';
          if (!text) break;
          const isThinking = msg.data?.thinking === true;

          if (!isThinking && captureFirstTurnPlanRef.current) {
            if (firstTurnPlanStartedRef.current || text.trim()) {
              firstTurnPlanStartedRef.current = true;
              firstTurnPlanChunksRef.current.push(text);
            }
          }

          // Start a new assistant message if we don't have one
          if (!currentAssistantRef.current) {
            currentAssistantRef.current = {
              id: `orch-assistant-${Date.now()}`,
              chunks: [],
              thinkingChunks: [],
            };
          }

          if (isThinking) {
            currentAssistantRef.current.thinkingChunks.push(text);
          } else {
            currentAssistantRef.current.chunks.push(text);
          }
          flushCurrentAssistant();

          if (statusRef.current !== 'busy') setStatus('busy');
          break;
        }

        case 'status': {
          const newStatus = msg.data?.status as string | undefined;
          if (newStatus === 'ready' || newStatus === 'busy' || newStatus === 'dead') {
            setStatus(newStatus);

            // When agent goes ready, finalize current assistant message
            // and mark any running tools as done
            if (newStatus === 'ready' && currentAssistantRef.current) {
              finalizeFirstTurnPlanCapture();
              flushCurrentAssistant();
              const finalId = currentAssistantRef.current.id;
              setMessages(prev => prev.map(m =>
                m.id === finalId && m.toolCalls?.some(t => t.status === 'running')
                  ? { ...m, toolCalls: m.toolCalls!.map(t => t.status === 'running' ? { ...t, status: 'done' } : t) }
                  : m
              ));
              currentAssistantRef.current = null;
            }
            if (newStatus === 'dead') {
              finalizeFirstTurnPlanCapture();
            }
          } else if (newStatus === 'starting') {
            setStatus('connecting');
          }
          break;
        }

        case 'agent-update': {
          const update = msg.data as {
            surfaceId?: string;
            name?: string;
            status?: string;
            detail?: string;
            duration?: number;
            repoPath?: string;
            prompt?: string;
          } | undefined;
          if (!update?.surfaceId) break;

          const detailText = update.detail ?? `Agent "${update.name ?? update.surfaceId}" is now ${update.status ?? 'unknown'}`;
          setMessages(prev => {
            // Dedup: skip if we already have an update for this surfaceId with the same detail
            const isDupe = prev.some(m =>
              m.id.startsWith(`agent-update-${update.surfaceId}`) &&
              m.text === detailText
            );
            if (isDupe) return prev;
            return [...prev, {
              id: `agent-update-${update.surfaceId}-${++agentUpdateSeq}`,
              role: 'system',
              text: detailText,
              timestamp: Date.now(),
              timestampLabel: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            }];
          });

          // Dispatch to dashboard so it can auto-open workspace tabs
          if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('cortex:agent-supervisor-update', { detail: update }));
          }
          break;
        }

        case 'tool-use': {
          const toolName = typeof msg.data?.name === 'string' ? msg.data.name : 'unknown';
          finalizeFirstTurnPlanCapture();

          // Ensure we have a current assistant message to attach the tool call to
          if (!currentAssistantRef.current) {
            currentAssistantRef.current = {
              id: `orch-assistant-${Date.now()}`,
              chunks: [],
              thinkingChunks: [],
            };
          }

          // Append to messages with toolCalls
          const current = currentAssistantRef.current;
          const toolCall = { name: toolName, status: 'running' as const };
          setMessages(prev => {
            const idx = prev.findIndex(m => m.id === current.id);
            if (idx >= 0) {
              const next = [...prev];
              const existing = next[idx];
              const existingTools = existing.toolCalls ?? [];
              // Mark previous running tools as done
              const updatedTools = existingTools.map(t =>
                t.status === 'running' ? { ...t, status: 'done' as const } : t,
              );
              next[idx] = { ...existing, toolCalls: [...updatedTools, toolCall] };
              return next;
            }
            // New message with tool call
            return [...prev, {
              id: current.id,
              role: 'assistant' as const,
              text: '',
              toolCalls: [toolCall],
              timestamp: Date.now(),
              timestampLabel: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            }];
          });

          if (statusRef.current !== 'busy') setStatus('busy');
          break;
        }

        case 'error': {
          const error = typeof msg.data?.error === 'string' ? msg.data.error : 'Unknown error';
          console.error('[orchestrator-stream] Error:', error);
          finalizeFirstTurnPlanCapture();
          setStatus('error');
          setMessages(prev => [...prev, {
            id: `orch-error-${Date.now()}`,
            role: 'system',
            text: `Orchestrator error: ${error}`,
            timestamp: Date.now(),
            timestampLabel: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          }]);
          break;
        }
      }
    };

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
  }, [flushCurrentAssistant]);

  // Connect on mount / repoPath change
  useEffect(() => {
    if (!repoPath) return;

    mountedRef.current = true;
    telemetrySessionKeyRef.current = null;
    telemetryTotalRef.current = null;
    setTokenCount(0);
    setRunningTotal(0);
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
  }, [repoPath, connect, refreshTokenTelemetry]);

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
    if (!repoPath) return;
    const compactKey = `o8:orchestrator:auto-compact:${repoPath}`;
    if (runningTotal < 250_000) autoCompactArmedRef.current = true;
    if (status !== 'ready' || runningTotal < 300_000 || autoCompactInFlightRef.current || !autoCompactArmedRef.current) return;
    if (typeof window !== 'undefined' && window.localStorage.getItem(compactKey)) return;
    autoCompactInFlightRef.current = true;
    autoCompactArmedRef.current = false;
    let started = false;
    const timer = window.setTimeout(() => {
      started = true;
      void (async () => {
        try {
          const response = await fetch('/api/orchestrator/compact', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ repoPath, runningTotal, messages: messagesRef.current }),
          });
          const payload = response.ok ? await response.json() as { ok?: boolean; applied?: boolean; transcript?: MobileTranscriptEntry[]; resumePrelude?: string | null; tokensAfter?: number } : null;
          if (!payload?.ok || !payload.applied || !Array.isArray(payload.transcript) || statusRef.current !== 'ready') {
            autoCompactArmedRef.current = true;
            return;
          }
          setMessages(payload.transcript);
          if (payload.resumePrelude && typeof window !== 'undefined') window.localStorage.setItem(compactKey, payload.resumePrelude);
          const nextTotal = typeof payload.tokensAfter === 'number' ? payload.tokensAfter : 0;
          telemetrySessionKeyRef.current = null;
          telemetryTotalRef.current = nextTotal;
          setTokenCount(0);
          setRunningTotal(nextTotal);
          emitTokenUsage({ repoPath, tokenCount: 0, runningTotal: nextTotal });
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
  }, [repoPath, runningTotal, status]);

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

  const send = useCallback((message: string, options?: { permissionMode?: OrchestratorPermissionMode; thinkingEffort?: 'medium' | 'high' | 'max' }) => {
    if (!repoPathRef.current) return;

    const permissionMode: OrchestratorPermissionMode = options?.permissionMode ?? 'full';
    const thinkingEffort = options?.thinkingEffort ?? 'max';

    // Add user message to local state immediately
    const userEntry: MobileTranscriptEntry = {
      id: `orch-user-${Date.now()}`,
      role: 'user',
      text: message,
      timestamp: Date.now(),
      timestampLabel: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    };
    setMessages(prev => [...prev, userEntry]);

    // Reset current assistant accumulator for the new response
    currentAssistantRef.current = null;
    captureFirstTurnPlanRef.current = !planTextRef.current
      && !hasHistoryRef.current
      && !messagesRef.current.some((entry) => entry.role === 'assistant' || entry.role === 'system' || entry.role === 'tool');
    firstTurnPlanStartedRef.current = false;
    firstTurnPlanChunksRef.current = [];
    setStatus('busy');

    void (async () => {
      let outboundMessage = message;
      const compactKey = `o8:orchestrator:auto-compact:${repoPathRef.current}`;
      const resumePrelude = typeof window !== 'undefined' ? window.localStorage.getItem(compactKey) : null;
      if (resumePrelude) {
        try {
          await fetch('/api/orchestrator/reset-session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ repoPath: repoPathRef.current }),
          });
        } catch { /* best effort */ }
        outboundMessage = `${resumePrelude}\n\nOperator message:\n${message}`;
        window.localStorage.removeItem(compactKey);
      }
      const payload = JSON.stringify({
        type: 'orchestrator-send',
        repoPath: repoPathRef.current,
        message: outboundMessage,
        permissionMode,
        thinkingEffort,
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
  }, [connect]);

  const reset = useCallback(() => {
    setMessages([]);
    setPlanText(null);
    setTokenCount(0);
    setRunningTotal(0);
    currentAssistantRef.current = null;
    planTextRef.current = null;
    telemetrySessionKeyRef.current = null;
    telemetryTotalRef.current = null;
    resetFirstTurnPlanCapture();
    setStatus(connected ? 'ready' : 'connecting');
    if (typeof window !== 'undefined' && repoPathRef.current) window.localStorage.removeItem(`o8:orchestrator:auto-compact:${repoPathRef.current}`);
    emitTokenUsage({ repoPath: repoPathRef.current, tokenCount: 0, runningTotal: 0 });
  }, [connected, resetFirstTurnPlanCapture]);

  return { messages, planText, status, busyState, tokenCount, runningTotal, send, reset, connected };
}
