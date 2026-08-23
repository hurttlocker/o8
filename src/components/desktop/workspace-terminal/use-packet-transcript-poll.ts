'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useOrchestratorData } from '@/components/desktop/orchestrator-data-context';
import { fetchWithLongLivedBudget } from '@/lib/connection-budget';
import type { MobileTranscriptEntry, MobileTranscriptToolCall } from '@/lib/mobile/types';
import type { TranscriptEvent } from '@/lib/orchestrator/transcript-normalizer';

const POLL_INTERVAL_MS = 3_000;

// Module-level semaphore: at most 2 transcript fetches in flight across ALL
// packet tabs. The webview shares ~6 HTTP/1.1 connections per origin; a
// 10-packet dispatch burst held 20+ transcript requests, starved lazy-chunk
// loads, and crashed the dashboard (2026-07-04 scoring run).
const MAX_CONCURRENT_TRANSCRIPT_FETCHES = 2;
let activeTranscriptFetches = 0;
const transcriptFetchWaiters: Array<() => void> = [];

function acquireTranscriptFetchSlot(): Promise<void> {
  if (activeTranscriptFetches < MAX_CONCURRENT_TRANSCRIPT_FETCHES) {
    activeTranscriptFetches += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    transcriptFetchWaiters.push(() => {
      activeTranscriptFetches += 1;
      resolve();
    });
  });
}

function releaseTranscriptFetchSlot(): void {
  activeTranscriptFetches = Math.max(0, activeTranscriptFetches - 1);
  const next = transcriptFetchWaiters.shift();
  if (next) next();
}
const TRANSCRIPT_TAIL_LIMIT = 200;

export interface PacketTranscriptActivity {
  label: string;
  startedAt: string | number | null;
}

export interface PacketTranscriptPollResult {
  entries: MobileTranscriptEntry[];
  activity: PacketTranscriptActivity | null;
}

export function shouldPollPacketTranscript(messages: MobileTranscriptEntry[]): boolean {
  return !messages.some((entry) => (
    entry.role === 'assistant'
    && (entry.text.trim().length > 0 || (entry.toolCalls?.length ?? 0) > 0)
  ));
}

/**
 * #1293 — Pure map from the normalized packet transcript (`TranscriptEvent[]`,
 * produced server-side by the SAME `normalizeCodexEvents` the AgentsTab uses)
 * into the `MobileTranscriptEntry[]` shape the workspace chat pane already
 * renders.
 *
 * Codex `exec --json` emits an interleaved stream of tool_call / tool_result /
 * assistant events. We fold each tool pair onto the assistant turn that closes
 * it so the shared `DesktopAgentMessage` receives the same raw entry contract
 * as the sessionKey-keyed transcript. Type-only import of `TranscriptEvent`
 * keeps this client-safe (the normalization runs in the API route).
 */
/**
 * TranscriptEvent.args is a display string: the raw string args verbatim, or
 * JSON.stringify of the original args object (clipped server-side at 600
 * chars). Recover the structure best-effort so tool chips label with the real
 * command / file path instead of the generic "terminal command" fallback —
 * six identical beige chips in a row tell the operator nothing.
 */
function parseToolCallArgs(raw: string | undefined): Record<string, unknown> | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      // Codex exec sends {"command":["bash","-lc","<cmd>"]} — flatten to the
      // human command string the chip renderers key on.
      if (Array.isArray(parsed.command)) {
        const parts = parsed.command.filter((part): part is string => typeof part === 'string');
        const cmdIndex = parts[0] === 'bash' || parts[0] === 'sh' || parts[0] === 'zsh'
          ? (parts[1] === '-lc' || parts[1] === '-c' ? 2 : 1)
          : 0;
        return { ...parsed, command: parts.slice(cmdIndex).join(' ') };
      }
      return parsed;
    } catch {
      return undefined; // clipped JSON — unrecoverable, chip falls back to preview
    }
  }
  return { command: trimmed };
}

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
          {
            name: event.tool,
            status: 'running',
            preview: event.summary || undefined,
            args: parseToolCallArgs(event.args),
          },
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
      case 'steer':
        entries.push({
          id: `pkt-steer-${event.seq}`,
          role: 'user',
          text: `${event.failed ? 'Steer failed to start' : event.source} · ${tsLabel(event.ts) ?? 'now'}\n\n${event.text}${event.note && event.note !== event.text ? `\n\n${event.note}` : ''}`,
          timestamp: tsMs(event.ts),
          timestampLabel: tsLabel(event.ts),
        });
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

function packetToolActivityLabel(event: Extract<TranscriptEvent, { type: 'tool_call' }>): string {
  if (event.tool === 'exec_command') return 'Running terminal command…';
  if (event.tool === 'read_file' || event.tool === 'Read') return 'Reading files…';
  if (event.tool === 'list_files' || event.tool === 'Glob') return 'Listing files…';
  if (event.tool === 'search_code' || event.tool === 'Grep') return 'Searching code…';
  if (event.tool === 'search_web' || event.tool === 'WebSearch') return 'Searching web…';
  if (event.tool === 'Edit' || event.tool === 'Write' || event.tool === 'NotebookEdit') return 'Editing files…';
  return `Running ${event.tool}…`;
}

export function derivePacketTranscriptActivity(events: TranscriptEvent[]): PacketTranscriptActivity | null {
  const latest = [...events].reverse().find((event) => event.type !== 'done');
  if (!latest) return null;
  if (latest.type === 'tool_call') return { label: packetToolActivityLabel(latest), startedAt: latest.ts };
  if (latest.type === 'assistant' || latest.type === 'tool_result') return { label: 'Thinking…', startedAt: latest.ts };
  if (latest.type === 'error') return { label: 'Recovering…', startedAt: latest.ts };
  return null;
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
  statusHint?: string | null;
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
  statusHint = null,
}: UsePacketTranscriptPollArgs): PacketTranscriptPollResult {
  const [packetEvents, setPacketEvents] = useState<MobileTranscriptEntry[]>([]);
  const [packetActivity, setPacketActivity] = useState<PacketTranscriptActivity | null>(null);
  const hasEventsRef = useRef(false);
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
  const status = livePacket?.status ?? statusHint;
  const visiblePacketEvents = enabled && (packetId || sessionKey) ? packetEvents : [];
  const visiblePacketActivity = enabled && (packetId || sessionKey) ? packetActivity : null;

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
      // 2026-07-04 scoring-run crash: 10 dispatched tabs each re-firing this
      // fetch on every mission-state churn held 20+ concurrent requests
      // against the webview's ~6-connection pool — starving lazy-chunk loads
      // and crashing the dashboard mount. Two dampers:
      //   1. Background tabs that already HAVE events don't refetch — the
      //      active tab's interval is the live view; background tabs refresh
      //      when focused.
      //   2. A module-level semaphore caps concurrent transcript fetches.
      if (!active && hasEventsRef.current) return;
      if (cancelled) return;
      await acquireTranscriptFetchSlot();
      try {
        if (cancelled) return;
        const response = await fetchWithLongLivedBudget(
          `/api/orchestrator/packet-transcript?${query}&tail=1&limit=${TRANSCRIPT_TAIL_LIMIT}`,
          { signal: controller.signal, cache: 'no-store' },
        );
        if (!response.ok) return;
        const payload = await response.json().catch(() => null) as { events?: TranscriptEvent[] } | null;
        if (cancelled || !payload || !Array.isArray(payload.events)) return;
        const mapped = mapPacketTranscriptEntries(payload.events);
        hasEventsRef.current = mapped.length > 0;
        setPacketEvents(mapped);
        setPacketActivity(derivePacketTranscriptActivity(payload.events));
      } catch {
        /* best-effort — transient network error or abort */
      } finally {
        releaseTranscriptFetchSlot();
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

  return { entries: visiblePacketEvents, activity: visiblePacketActivity };
}
