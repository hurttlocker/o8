import type { Dispatch, SetStateAction } from 'react';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import { isCortexAskTool, parseBrainFeed } from '@/components/desktop/thoughts/brain-feed';
import { skipDuplicateBySeq } from '@/lib/orchestrator/replay-cursor';
import {
  formatTimestampLabel,
  type OrchestratorStreamStatus,
} from './shared';

interface RefLike<T> {
  current: T;
}

export interface CurrentAssistantStreamState {
  id: string;
  chunks: string[];
  thinkingChunks: string[];
  epoch: number;
  /** Wall-clock start of the reasoning phase. Claude 5-family thinking is
   *  signature-redacted (empty text), so the empty thinking marker is the only
   *  start signal — the duration it yields drives the "Thought for Ns" line. */
  thinkingStartedAt?: number | null;
  /** Frozen reasoning duration — stamped once when the first answer token or
   *  tool call ends the thinking phase. */
  thinkingDurationMs?: number | null;
}

interface CreateOrchestratorMessageHandlerOptions {
  captureFirstTurnPlanRef: RefLike<boolean>;
  currentWs: WebSocket;
  currentAssistantRef: RefLike<CurrentAssistantStreamState | null>;
  eventCountRef: RefLike<number>;
  /** Highest event seq applied for this session — drives replay de-dup. */
  lastSeqRef: RefLike<number>;
  finalizeFirstTurnPlanCapture: () => void;
  firstTurnPlanChunksRef: RefLike<string[]>;
  firstTurnPlanStartedRef: RefLike<boolean>;
  flushCurrentAssistant: () => void;
  /** Coalesced (rAF-batched) flush for the streaming-text path — one re-render per frame. */
  scheduleFlushCurrentAssistant: () => void;
  /**
   * Last backend id seen on any orchestrator event (`data.backend` rides every
   * ws-server emission, including the subscribe-ack snapshot). Fable Slice 4:
   * the auto-compact effect reads this to pick the metered vs global threshold.
   */
  lastBackendRef?: RefLike<string | null>;
  lastEventAtRef: RefLike<number>;
  messagesRef: RefLike<MobileTranscriptEntry[]>;
  onOrchestratorActivity?: (event: {
    event: string;
    data?: Record<string, unknown>;
    observedAt: number;
  }) => void;
  resetEpochRef: RefLike<number>;
  setMessages: Dispatch<SetStateAction<MobileTranscriptEntry[]>>;
  setStatus: Dispatch<SetStateAction<OrchestratorStreamStatus>>;
  statusRef: RefLike<OrchestratorStreamStatus>;
  wsRef: RefLike<WebSocket | null>;
}

function createAssistantState(
  resetEpochRef: RefLike<number>,
  assistantMessageId?: unknown,
): CurrentAssistantStreamState {
  return {
    id: typeof assistantMessageId === 'string' && assistantMessageId.trim()
      ? assistantMessageId.trim()
      : `assistant-${Date.now()}`,
    chunks: [],
    thinkingChunks: [],
    epoch: resetEpochRef.current,
  };
}

export function createOrchestratorMessageHandler(
  options: CreateOrchestratorMessageHandlerOptions,
) {
  const setTranscriptMessages = (update: SetStateAction<MobileTranscriptEntry[]>) => {
    options.setMessages((prev) => {
      const next = typeof update === 'function'
        ? (update as (prev: MobileTranscriptEntry[]) => MobileTranscriptEntry[])(prev)
        : update;
      options.messagesRef.current = next;
      return next;
    });
  };

  return (event: MessageEvent) => {
    if (options.currentWs !== options.wsRef.current) return;

    let msg: { channel?: string; event?: string; data?: Record<string, unknown>; seq?: number };
    try {
      msg = JSON.parse(typeof event.data === 'string' ? event.data : '');
    } catch {
      return;
    }

    // #529 — Supervisor/agent lifecycle events ride a separate channel so
    // their `detail` payloads (codex transcript previews, stuck steers, etc.)
    // cannot bleed into the orchestrator chat. We still listen for them on
    // the same underlying WebSocket connection, but route them straight to
    // the window-level listener without touching transcript state.
    if (msg.channel === 'supervisor') {
      if (msg.event !== 'agent-update') return;
      const update = msg.data as {
        surfaceId?: string;
        name?: string;
        status?: string;
        detail?: string;
        duration?: number;
        repoPath?: string;
        prompt?: string;
      } | undefined;
      if (!update?.surfaceId) return;
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('cortex:agent-supervisor-update', { detail: update }));
      }
      return;
    }

    if (msg.channel !== 'orchestrator') return;

    const observedAt = Date.now();
    options.onOrchestratorActivity?.({
      event: typeof msg.event === 'string' ? msg.event : '',
      data: msg.data,
      observedAt,
    });

    // Track the active backend BEFORE seq-dedup/snapshot gating — a snapshot or
    // replayed event is still truthful about which backend owns the session.
    if (options.lastBackendRef && typeof msg.data?.backend === 'string') {
      options.lastBackendRef.current = msg.data.backend;
    }

    // Replay de-dup: live + replayed events carry a monotonic per-session seq.
    // Skip anything we've already applied so a replay overlap (or a re-
    // subscribe) can't double-apply tokens. Snapshot/notice sends have no seq.
    if (skipDuplicateBySeq(msg, options.lastSeqRef)) return;

    // Snapshot (subscribe-ack) sends are a point-in-time status, NOT live
    // activity. Counting them advances the reconnect-heal guard AND keeps
    // resetting the stale-busy watchdog, so a 'busy' snapshot for a dead session
    // would pin the "Working" timer forever. Only live events advance these. (#1282)
    if (msg.data?.snapshot !== true) {
      options.eventCountRef.current += 1;
      options.lastEventAtRef.current = observedAt;
    }

    // #register-mcp — transient banner notices ride the same channel but
    // don't touch transcript state. They're dispatched to a window listener
    // that the chat panel subscribes to via useOrchestratorReloadNotice.
    if (msg.event === 'notice') {
      const data = msg.data as {
        kind?: string;
        noticeId?: string;
        message?: string;
        registered?: unknown;
        repoPath?: string;
      } | undefined;
      if (data && typeof data.kind === 'string' && typeof data.noticeId === 'string' && typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('cortex:orchestrator-notice', { detail: data }));
      }
      return;
    }

    switch (msg.event) {
      case 'output': {
        const text = typeof msg.data?.text === 'string' ? msg.data.text : '';
        const isThinkingMarker = msg.data?.thinking === true;

        // Empty thinking marker — Claude 5-family reasoning streams
        // signature-only (content redacted at the API), so the block-start
        // event with no text is the ONLY signal a reasoning phase began.
        // Materialize the assistant entry with `thinkingActive` so the
        // transcript shows a live "Thinking" line, and stamp the start time
        // for the "Thought for Ns" duration once reasoning ends.
        if (!text) {
          if (!isThinkingMarker) break;
          if (!options.currentAssistantRef.current) {
            if (options.statusRef.current !== 'busy') {
              options.statusRef.current = 'busy';
              options.setStatus('busy');
            }
            options.currentAssistantRef.current = createAssistantState(options.resetEpochRef, msg.data?.assistantMessageId);
          }
          const thinkingState = options.currentAssistantRef.current;
          if (thinkingState.thinkingStartedAt == null) {
            thinkingState.thinkingStartedAt = Date.now();
            setTranscriptMessages((prev) => {
              const idx = prev.findIndex((message) => message.id === thinkingState.id);
              if (idx >= 0) {
                const next = [...prev];
                next[idx] = { ...next[idx], thinkingActive: true };
                return next;
              }
              return [...prev, {
                id: thinkingState.id,
                role: 'assistant' as const,
                text: '',
                thinkingActive: true,
                timestamp: Date.now(),
                timestampLabel: formatTimestampLabel(Date.now()),
              }];
            });
          }
          break;
        }
        const isThinking = isThinkingMarker;

        if (!isThinking && options.captureFirstTurnPlanRef.current) {
          if (options.firstTurnPlanStartedRef.current || text.trim()) {
            options.firstTurnPlanStartedRef.current = true;
            options.firstTurnPlanChunksRef.current.push(text);
          }
        }

        if (!options.currentAssistantRef.current) {
          // Output arriving IS proof the turn is live — never drop it on a
          // status mismatch. The first-turn re-subscribe race (threadId mints
          // mid-turn → re-subscribe → the server's snapshot status can land as
          // non-'busy' right as the first tokens arrive) used to `break` here
          // and silently kill the entire stream until a reload. Promote to busy
          // and render instead. 2026-06-18.
          if (options.statusRef.current !== 'busy') {
            options.statusRef.current = 'busy';
            options.setStatus('busy');
          }
          options.currentAssistantRef.current = createAssistantState(options.resetEpochRef, msg.data?.assistantMessageId);
        } else if (options.currentAssistantRef.current.epoch !== options.resetEpochRef.current) {
          options.currentAssistantRef.current = null;
          break;
        }

        if (isThinking) {
          const state = options.currentAssistantRef.current;
          if (state.thinkingStartedAt == null) state.thinkingStartedAt = Date.now();
          state.thinkingChunks.push(text);
        } else {
          const state = options.currentAssistantRef.current;
          // First answer token ends the reasoning phase — freeze the duration.
          if (state.thinkingStartedAt != null && state.thinkingDurationMs == null) {
            state.thinkingDurationMs = Date.now() - state.thinkingStartedAt;
          }
          state.chunks.push(text);
        }
        // Coalesced rAF flush for streaming deltas (see useOrchestratorStream) —
        // one re-render per frame instead of one per token.
        options.scheduleFlushCurrentAssistant();

        if (options.statusRef.current !== 'busy') options.setStatus('busy');
        break;
      }

      case 'status': {
        const newStatus = msg.data?.status as string | undefined;
        // A subscribe-ack carries a point-in-time SNAPSHOT of the session
        // status (ws-server tags it `snapshot:true`), NOT a live turn
        // transition. On the first turn of a fresh tab the threadId mints
        // mid-turn, forcing a re-subscribe whose snapshot can arrive as 'ready'
        // right after `send()` optimistically set 'busy' — adopting it would
        // clobber the in-flight turn, and the output guard above would then
        // silently drop every token (dead until reload). So a snapshot may
        // resync an idle client (settle 'ready', or move UP to 'busy' on a
        // reload into an active turn) but must NEVER downgrade or finalize a
        // live local 'busy'. 2026-06-18.
        const isSnapshot = msg.data?.snapshot === true;
        if (newStatus === 'ready' || newStatus === 'busy' || newStatus === 'dead') {
          if (isSnapshot) {
            if (options.statusRef.current === 'busy' && newStatus !== 'busy') break;
            options.statusRef.current = newStatus;
            options.setStatus(newStatus);
            break;
          }
          if (
            newStatus === 'busy'
            && options.statusRef.current !== 'busy'
            && options.currentAssistantRef.current === null
            && options.messagesRef.current.length === 0
          ) {
            break;
          }
          options.statusRef.current = newStatus;
          options.setStatus(newStatus);

          if (newStatus === 'ready' && options.currentAssistantRef.current) {
            options.finalizeFirstTurnPlanCapture();
            const endedState = options.currentAssistantRef.current;
            // Turn ended mid-reasoning (abort / thinking-only turn) — freeze
            // the duration so the entry can't keep a live "Thinking" shimmer.
            if (endedState.thinkingStartedAt != null && endedState.thinkingDurationMs == null) {
              endedState.thinkingDurationMs = Date.now() - endedState.thinkingStartedAt;
            }
            const finalThinkingDurationMs = endedState.thinkingDurationMs ?? undefined;
            options.flushCurrentAssistant();
            const finalId = endedState.id;
            setTranscriptMessages((prev) => prev.map((message) => {
              if (message.id !== finalId) return message;
              const needsToolSettle = message.toolCalls?.some((tool) => tool.status === 'running');
              const needsThinkingSettle = message.thinkingActive === true;
              if (!needsToolSettle && !needsThinkingSettle) return message;
              return {
                ...message,
                ...(needsToolSettle
                  ? { toolCalls: message.toolCalls!.map((tool) => (tool.status === 'running' ? { ...tool, status: 'done' as const } : tool)) }
                  : {}),
                ...(needsThinkingSettle
                  ? { thinkingActive: false, ...(finalThinkingDurationMs !== undefined ? { thinkingDurationMs: finalThinkingDurationMs } : {}) }
                  : {}),
              };
            }));
            options.currentAssistantRef.current = null;
          }
          if (newStatus === 'dead') {
            options.finalizeFirstTurnPlanCapture();
          }
        } else if (newStatus === 'starting') {
          options.statusRef.current = 'connecting';
          options.setStatus('connecting');
        }
        break;
      }

      case 'tool-use': {
        const toolName = typeof msg.data?.name === 'string' ? msg.data.name : 'unknown';
        options.finalizeFirstTurnPlanCapture();

        if (!options.currentAssistantRef.current) {
          // A tool-use event is also proof of a live turn — same rationale as
          // the output case: promote to busy instead of dropping the pill.
          if (options.statusRef.current !== 'busy') {
            options.statusRef.current = 'busy';
            options.setStatus('busy');
          }
          options.currentAssistantRef.current = createAssistantState(options.resetEpochRef, msg.data?.assistantMessageId);
        }

        const current = options.currentAssistantRef.current;
        // A tool call also ends the reasoning phase — freeze the duration.
        if (current.thinkingStartedAt != null && current.thinkingDurationMs == null) {
          current.thinkingDurationMs = Date.now() - current.thinkingStartedAt;
        }
        const thinkingDurationMs = current.thinkingDurationMs ?? undefined;
        // Capture args (the tool input — e.g. a Task scout's description/type)
        // and the tool id. The desktop handler used to drop both, which is why
        // native Claude scouts reached the transcript unlabeled. The SwarmStatusCard
        // reads args.description to label each scout in the live crew.
        const toolArgs =
          typeof msg.data?.args === 'object' && msg.data?.args !== null
            ? (msg.data.args as Record<string, unknown>)
            : undefined;
        const toolUseId = typeof msg.data?.toolUseId === 'string' ? msg.data.toolUseId : null;
        const toolCall = { id: toolUseId, name: toolName, status: 'running' as const, args: toolArgs };
        setTranscriptMessages((prev) => {
          const idx = prev.findIndex((message) => message.id === current.id);
          if (idx >= 0) {
            const next = [...prev];
            const existing = next[idx];
            const existingTools = existing.toolCalls ?? [];
            const updatedTools = existingTools.map((tool) =>
              tool.status === 'running' ? { ...tool, status: 'done' as const } : tool,
            );
            next[idx] = {
              ...existing,
              toolCalls: [...updatedTools, toolCall],
              ...(thinkingDurationMs !== undefined ? { thinkingDurationMs, thinkingActive: false } : {}),
            };
            return next;
          }
          return [...prev, {
            id: current.id,
            role: 'assistant' as const,
            text: '',
            toolCalls: [toolCall],
            ...(thinkingDurationMs !== undefined ? { thinkingDurationMs, thinkingActive: false } : {}),
            timestamp: Date.now(),
            timestampLabel: formatTimestampLabel(Date.now()),
          }];
        });

        if (options.statusRef.current !== 'busy') options.setStatus('busy');
        break;
      }

      case 'tool-result': {
        // Brain→Fable transparency card (2026-07-02). The ws-server forwards
        // EVERY tool_result over this channel (`data.output` = the raw result
        // string). The transcript consumes two slices of it:
        //   1. `isError` (turn-grammar deliverable 3) — flip the originating
        //      chip to an error badge + stash the output, for ANY tool. The
        //      ToolCallChipCluster auto-expands an errored chip so the failure
        //      is visible without a click.
        //   2. cortex_ask payload — parse the Brain feed onto the chip so the
        //      metered-backend card shows what the Brain fed the orchestrator.
        // A SUCCESSFUL non-cortex result stays ignored — the chip flips
        // running→done via the next tool-use / live 'ready' as before.
        const resultName = typeof msg.data?.name === 'string' ? msg.data.name : '';
        const isError = msg.data?.isError === true;
        const output = typeof msg.data?.output === 'string' ? msg.data.output : '';
        const toolUseId = typeof msg.data?.toolUseId === 'string' ? msg.data.toolUseId : null;
        const backend = typeof msg.data?.backend === 'string' ? msg.data.backend : undefined;
        const current = options.currentAssistantRef.current;
        if (!current) break;

        if (isError) {
          setTranscriptMessages((prev) => {
            const idx = prev.findIndex((message) => message.id === current.id);
            if (idx < 0) return prev;
            const tools = prev[idx].toolCalls ?? [];
            // Match by toolUseId; fall back to the latest still-in-flight chip.
            let toolIdx = toolUseId ? tools.findIndex((tool) => tool.id === toolUseId) : -1;
            if (toolIdx < 0) {
              for (let i = tools.length - 1; i >= 0; i -= 1) {
                if (tools[i].status === 'running' || tools[i].status === 'calling') { toolIdx = i; break; }
              }
            }
            if (toolIdx < 0) return prev;
            const nextTools = [...tools];
            nextTools[toolIdx] = {
              ...nextTools[toolIdx],
              status: 'error' as const,
              ...(output ? { result: output } : {}),
              ...(backend ? { backend } : {}),
            };
            const next = [...prev];
            next[idx] = { ...prev[idx], toolCalls: nextTools };
            return next;
          });
        }

        if (!isCortexAskTool(resultName)) break;
        if (!output) break;
        setTranscriptMessages((prev) => {
          const idx = prev.findIndex((message) => message.id === current.id);
          if (idx < 0) return prev;
          const tools = prev[idx].toolCalls ?? [];
          // Match by toolUseId; fall back to the latest cortex_ask call so a
          // missing id (older parser events) still lands on the right chip.
          let toolIdx = toolUseId ? tools.findIndex((tool) => tool.id === toolUseId) : -1;
          if (toolIdx < 0) {
            for (let i = tools.length - 1; i >= 0; i -= 1) {
              if (isCortexAskTool(tools[i].name)) { toolIdx = i; break; }
            }
          }
          if (toolIdx < 0) return prev;
          const tool = tools[toolIdx];
          const brainFeed = parseBrainFeed(output, tool.args) ?? undefined;
          const nextTools = [...tools];
          nextTools[toolIdx] = {
            ...tool,
            // Preserve an error badge on a failed Brain call; otherwise done.
            status: isError ? 'error' as const : 'done' as const,
            result: output,
            ...(backend ? { backend } : {}),
            ...(brainFeed ? { brainFeed } : {}),
          };
          const next = [...prev];
          next[idx] = { ...prev[idx], toolCalls: nextTools };
          return next;
        });
        break;
      }

      // ── Collide (MoA) pre-roll. The proposers buffer; these two events drive the
      //    faint, collapsible "proposals collided" card that precedes the answer.
      //    Proposer text NEVER becomes assistant text — only the aggregator streams.
      case 'collide-phase': {
        const phase = msg.data?.phase === 'synthesizing' ? 'synthesizing' : 'proposing';
        const proposers = Array.isArray(msg.data?.proposers) ? (msg.data!.proposers as string[]) : [];
        if (options.statusRef.current !== 'busy') {
          options.statusRef.current = 'busy';
          options.setStatus('busy');
        }
        if (phase === 'proposing') {
          setTranscriptMessages((prev) => [...prev, {
            id: `collide-${Date.now()}`,
            role: 'system' as const,
            text: '',
            collide: { phase: 'proposing', proposers, proposals: [] },
            timestamp: Date.now(),
            timestampLabel: formatTimestampLabel(Date.now()),
          }]);
        } else {
          // synthesizing — collapse the most recent active collide card.
          setTranscriptMessages((prev) => {
            const idx = [...prev].reverse().findIndex((m) => m.collide && m.collide.phase === 'proposing');
            if (idx < 0) return prev;
            const realIdx = prev.length - 1 - idx;
            const next = [...prev];
            next[realIdx] = { ...next[realIdx], collide: { ...next[realIdx].collide!, phase: 'synthesizing' } };
            return next;
          });
        }
        break;
      }

      case 'collide-proposal': {
        const proposer = typeof msg.data?.proposer === 'string' ? msg.data.proposer : 'proposer';
        const text = typeof msg.data?.text === 'string' ? msg.data.text : '';
        const breach = msg.data?.breach === true;
        setTranscriptMessages((prev) => {
          const idx = [...prev].reverse().findIndex((m) => m.collide && m.collide.phase === 'proposing');
          if (idx < 0) return prev;
          const realIdx = prev.length - 1 - idx;
          const next = [...prev];
          const card = next[realIdx].collide!;
          next[realIdx] = {
            ...next[realIdx],
            collide: { ...card, proposals: [...card.proposals, { proposer, text, breach }] },
          };
          return next;
        });
        break;
      }

      case 'error': {
        if (options.statusRef.current !== 'busy' && options.messagesRef.current.length === 0) break;
        const error = typeof msg.data?.error === 'string' ? msg.data.error : 'Unknown error';
        console.error('[orchestrator-stream] Error:', error);
        options.finalizeFirstTurnPlanCapture();
        options.setStatus('error');
        setTranscriptMessages((prev) => [...prev, {
          id: `orch-error-${Date.now()}`,
          role: 'system',
          text: `Orchestrator error: ${error}`,
          timestamp: Date.now(),
          timestampLabel: formatTimestampLabel(Date.now()),
        }]);
        break;
      }
    }
  };
}
