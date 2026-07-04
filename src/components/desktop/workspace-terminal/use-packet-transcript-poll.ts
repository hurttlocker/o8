'use client';

import { useEffect, useMemo, useState } from 'react';
import { useOrchestratorData } from '@/components/desktop/orchestrator-data-context';
import { fetchWithLongLivedBudget } from '@/lib/connection-budget';
import type { MobileTranscriptEntry, MobileTranscriptToolCall } from '@/lib/mobile/types';
import type { TranscriptEvent } from '@/lib/orchestrator/transcript-normalizer';

const POLL_INTERVAL_MS = 3_000;
const TRANSCRIPT_TAIL_LIMIT = 200;

/**
 * #1293 — Pure map from the normalized packet transcript (`TranscriptEvent[]`,
 * produced server-side by the SAME `normalizeCodexEvents` the AgentsTab uses)
 * into the `MobileTranscriptEntry[]` shape the workspace chat pane already
 * renders.
 *
 * Codex `exec --json` emits an interleaved stream of tool_call / tool_result /
 * assistant events. We fold each tool pair onto the assistant turn that closes
 * it so `WorkspaceRichChatEvents` can render the tool cards — the same contract
 * the sessionKey-keyed transcript uses. Type-only import of `TranscriptEvent`
 * keeps this client-safe (the normalization runs in the API route).
 */
export function mapPacketTranscriptEntries(events: TranscriptEvent[]): MobileTranscriptEntry[] {
  const entries: MobileTranscriptEntry[] = [];
  let pendingTools: MobileTranscriptToolCall[] = [];

  const tsMs = (ts: string): number => {
    const parsed = new Date(ts).getTime();
    return Number.isFinite(parsed) ? parsed : Date.now();
  };
  const tsLabel = (ts: string): string | undefined => {
    const parsed = new Date(ts).getTime();
    return Number.isFinite(parsed)
      ? new Date(parsed).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : undefined;
  };
  const flush = (id: string, text: string, ts: string): void => {
    entries.push({
      id,
      role: 'assistant',
      text,
      timestamp: tsMs(ts),
      timestampLabel: tsLabel(ts),
      toolCalls: pendingTools.length > 0 ? pendingTools : undefined,
    });
    pendingTools = [];
  };

  for (const event of events) {
    switch (event.type) {
      case 'tool_call':
        pendingTools = [
          ...pendingTools,
          { name: event.tool, status: 'running', preview: event.summary || undefined },
        ];
        break;
      case 'tool_result': {
        // Close the most recent matching pending call; else append a done card.
        const reversedIdx = [...pendingTools].reverse().findIndex((tool) => tool.name === event.tool);
        if (reversedIdx >= 0) {
          const realIdx = pendingTools.length - 1 - reversedIdx;
          pendingTools = pendingTools.map((tool, idx) => (
            idx === realIdx ? { ...tool, status: 'done', preview: event.summary || tool.preview } : tool
          ));
        } else {
          pendingTools = [
            ...pendingTools,
            { name: event.tool, status: 'done', preview: event.summary || undefined },
          ];
        }
        break;
      }
      case 'assistant':
        flush(`pkt-${event.seq}`, event.text, event.ts);
        break;
      case 'error':
        flush(`pkt-${event.seq}`, `Error: ${event.message}`, event.ts);
        break;
      case 'done':
      default:
        break;
    }
  }

  // Trailing in-flight tool calls with no closing assistant turn yet — surface
  // them so the operator watches the agent work mid-turn.
  if (pendingTools.length > 0) {
    const last = entries[entries.length - 1];
    if (last && last.role === 'assistant' && (!last.toolCalls || last.toolCalls.length === 0)) {
      last.toolCalls = pendingTools;
    } else {
      entries.push({ id: `pkt-live-${entries.length}`, role: 'assistant', text: '', toolCalls: pendingTools });
    }
  }

  return entries;
}

interface UsePacketTranscriptPollArgs {
  /**
   * ADDITIVE gate. Must be `true` ONLY when the sessionKey-keyed transcript
   * slice is empty/idle (a dispatched, un-steered Codex packet). Claude-Code
   * packets fill the sessionKey slice via /api/claude-code/send, and steered
   * Codex fills it via the bootstrap poll — both keep this `false`, so their
   * render path is byte-identical and untouched.
   */
  enabled: boolean;
  packetIdHint: string | null;
  sessionKey: string | null;
  active: boolean;
}

/**
 * #1293 FIX 1 — additive packetId-keyed transcript poll that runs ALONGSIDE the
 * existing sessionKey bootstrap. A dispatched Codex `exec --json` streams its
 * transcript to the LANE, not the sessionKey slice, so the tab otherwise shows
 * a perpetual static placeholder. When gated on (empty sessionKey slice), this
 * pulls `GET /api/orchestrator/packet-transcript?packetId=…&tail=1` and returns
 * the mapped entries. Polls ~3s while the live packet is running/recovering and
 * goes quiet once terminal.
 */
export function usePacketTranscriptPoll({
  enabled,
  packetIdHint,
  sessionKey,
  active,
}: UsePacketTranscriptPollArgs): MobileTranscriptEntry[] {
  const [packetEvents, setPacketEvents] = useState<MobileTranscriptEntry[]>([]);
  const orchestratorData = useOrchestratorData();

  // Resolve the live packet the same way WorkspaceChatPane does — explicit
  // packetId first, then the lane sessionKey — so the poll tracks the real lane
  // lifecycle and knows when to stop.
  const livePacket = useMemo(() => {
    if (!packetIdHint && !sessionKey) return null;
    return orchestratorData?.missionState?.packets.find((packet) => (
      (packetIdHint != null && packet.id === packetIdHint)
      || (sessionKey != null && packet.lane?.sessionKey === sessionKey)
    )) ?? null;
  }, [orchestratorData?.missionState?.packets, packetIdHint, sessionKey]);

  const packetId = livePacket?.id ?? packetIdHint;
  const status = livePacket?.status ?? null;
  const visiblePacketEvents = enabled && (packetId || sessionKey) ? packetEvents : [];

  useEffect(() => {
    // sessionKey fallback — the tab always carries its lane sessionKey, but
    // packetId depends on the packet badge AND the client mission-state
    // projection, both of which go stale/missing when missions are created
    // outside the desktop flow (MCP dispatch, #1389). Live-hit 2026-07-04:
    // packetId resolved to null on every dispatched tab, the poll never fired,
    // and every transcript showed "Agent working…" over a healthy backend.
    const query = packetId
      ? `packetId=${encodeURIComponent(packetId)}`
      : sessionKey
        ? `sessionKey=${encodeURIComponent(sessionKey)}`
        : null;
    if (!enabled || !query) {
      return undefined;
    }
    const controller = new AbortController();
    let cancelled = false;
    const run = async () => {
      try {
        const response = await fetchWithLongLivedBudget(
          `/api/orchestrator/packet-transcript?${query}&tail=1&limit=${TRANSCRIPT_TAIL_LIMIT}`,
          { signal: controller.signal, cache: 'no-store' },
        );
        if (!response.ok) return;
        const payload = await response.json().catch(() => null) as { events?: TranscriptEvent[] } | null;
        if (cancelled || !payload || !Array.isArray(payload.events)) return;
        setPacketEvents(mapPacketTranscriptEntries(payload.events));
      } catch {
        /* best-effort — transient network error or abort */
      }
    };
    void run();
    let interval: number | undefined;
    // status === null means the packet is not in the CURRENT mission's state —
    // which happens whenever the current-mission pointer has moved on (#1389)
    // even though the lane and its transcript are alive. Going quiet here left
    // every non-current-mission tab stuck on the one-shot fetch ("Agent
    // working…" forever, live-hit 2026-07-03). Unknown status keeps polling
    // while the tab is active; terminal statuses still stop the interval.
    if (active && (status === 'running' || status === 'recovering' || status === null)) {
      interval = window.setInterval(() => { void run(); }, POLL_INTERVAL_MS);
    }
    return () => {
      cancelled = true;
      controller.abort();
      if (interval !== undefined) window.clearInterval(interval);
    };
  }, [enabled, packetId, sessionKey, status, active]);

  return visiblePacketEvents;
}
