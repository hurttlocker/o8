'use client';

/**
 * useAgentTranscript — the live transcript tail for a canvas agent card.
 *
 * Reuses the SAME seam the IDE's packet tabs + the spawned-agent hover card read
 * (`GET /api/orchestrator/packet-transcript`, normalized `TranscriptEvent[]` from
 * `readPacketTranscriptEvents`). We don't invent a channel — we poll the exact
 * endpoint `use-packet-transcript-poll.ts` and `SpawnedAgentHoverCard.tsx` poll,
 * and fold the normalized events into compact log lines the card renders.
 *
 * The canvas preview surface is NOT wrapped in OrchestratorDataProvider, so we
 * can't lift the IDE's hook (it resolves live status from that context); instead
 * this takes the live/terminal signal from the card's own lane row and keeps a
 * small, purpose-built compact-line shape.
 */

import { useEffect, useRef, useState } from 'react';
import type { TranscriptEvent } from '@/lib/orchestrator/transcript-normalizer';

const POLL_MS = 3_000;
const TAIL_LIMIT = 200;
/** Keep at most this many mapped lines in memory per card (brief: a few hundred). */
const KEEP_LINES = 160;

// Module-level semaphore — a fleet of agent cards must not each hold a transcript
// request against the webview's ~6-connection pool (the 2026-07-04 scoring-run
// crash that hardened the IDE hook). Cap concurrent transcript fetches globally.
const MAX_CONCURRENT = 2;
let inFlight = 0;
const waiters: Array<() => void> = [];
function acquire(): Promise<void> {
  if (inFlight < MAX_CONCURRENT) {
    inFlight += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiters.push(() => { inFlight += 1; resolve(); }));
}
function release(): void {
  inFlight = Math.max(0, inFlight - 1);
  waiters.shift()?.();
}

export interface AgentLogLine {
  seq: number;
  kind: 'assistant' | 'tool' | 'error';
  text: string;
}

/** A compact, past-tense label for a tool call ("ran command · npm test"). */
function toolLabel(event: Extract<TranscriptEvent, { type: 'tool_call' }>): string {
  const tool = event.tool;
  const verb =
    tool === 'exec_command' ? 'ran command'
      : tool === 'read_file' || tool === 'Read' ? 'read a file'
        : tool === 'list_files' || tool === 'Glob' ? 'listed files'
          : tool === 'search_code' || tool === 'Grep' ? 'searched code'
            : tool === 'search_web' || tool === 'WebSearch' ? 'searched the web'
              : tool === 'Edit' || tool === 'Write' || tool === 'NotebookEdit' || tool === 'apply_patch' ? 'edited a file'
                : `ran ${tool}`;
  const detail = event.summary?.trim();
  return detail ? `${verb} · ${detail}` : verb;
}

/** Fold the normalized transcript into compact log lines. tool_result/steer/done
 *  are intentionally dropped: the tool_call line already names the action, and
 *  steer messages are owned by the card composer's own optimistic list (no dupes). */
export function mapAgentLogLines(events: TranscriptEvent[]): AgentLogLine[] {
  const out: AgentLogLine[] = [];
  for (const event of events) {
    if (event.type === 'assistant') {
      const text = event.text.trim();
      if (text) out.push({ seq: event.seq, kind: 'assistant', text });
    } else if (event.type === 'tool_call') {
      out.push({ seq: event.seq, kind: 'tool', text: toolLabel(event) });
    } else if (event.type === 'error') {
      out.push({ seq: event.seq, kind: 'error', text: event.message.trim() || 'Error' });
    }
  }
  return out.slice(-KEEP_LINES);
}

export type AgentTranscriptStatus = 'idle' | 'loading' | 'loaded' | 'empty' | 'unavailable';

export interface AgentTranscriptState {
  lines: AgentLogLine[];
  status: AgentTranscriptStatus;
}

/**
 * Poll the packet transcript while the card is expanded. `live` (lane still
 * non-terminal) drives the repeating interval; even a settled lane fetches once
 * on enable so the card shows the final transcript.
 */
export function useAgentTranscript({
  packetId,
  sessionKey,
  live,
  enabled,
}: {
  packetId: string | null;
  sessionKey: string | null;
  live: boolean;
  enabled: boolean;
}): AgentTranscriptState {
  const [lines, setLines] = useState<AgentLogLine[]>([]);
  const [status, setStatus] = useState<AgentTranscriptStatus>('idle');
  const hasLoadedRef = useRef(false);

  const query = packetId
    ? `packetId=${encodeURIComponent(packetId)}`
    : sessionKey
      ? `sessionKey=${encodeURIComponent(sessionKey)}`
      : null;

  useEffect(() => {
    if (!enabled || !query) return undefined;
    let cancelled = false;
    const controller = new AbortController();
    if (!hasLoadedRef.current) setStatus('loading');

    const run = async () => {
      if (cancelled) return;
      await acquire();
      try {
        if (cancelled) return;
        const response = await fetch(
          `/api/orchestrator/packet-transcript?${query}&tail=1&limit=${TAIL_LIMIT}`,
          { signal: controller.signal, cache: 'no-store' },
        );
        if (!response.ok) {
          if (!hasLoadedRef.current && !cancelled) setStatus('unavailable');
          return;
        }
        const payload = await response.json().catch(() => null) as { events?: TranscriptEvent[] } | null;
        if (cancelled || !payload || !Array.isArray(payload.events)) return;
        const mapped = mapAgentLogLines(payload.events);
        hasLoadedRef.current = true;
        setLines(mapped);
        setStatus(mapped.length > 0 ? 'loaded' : 'empty');
      } catch {
        /* transient network error / abort — keep the last good tail */
      } finally {
        release();
      }
    };

    void run();
    let interval: number | undefined;
    if (live) interval = window.setInterval(() => { void run(); }, POLL_MS);
    return () => {
      cancelled = true;
      controller.abort();
      if (interval !== undefined) window.clearInterval(interval);
    };
  }, [enabled, query, live]);

  return { lines, status };
}
