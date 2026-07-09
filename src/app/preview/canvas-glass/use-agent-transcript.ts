'use client';

/**
 * useAgentTranscript — the live transcript tail for a canvas agent card.
 *
 * Reuses the SAME seam the IDE's packet tabs + the spawned-agent hover card read
 * (`GET /api/orchestrator/packet-transcript`, normalized `TranscriptEvent[]` from
 * `readPacketTranscriptEvents`). We don't invent a channel — we poll the exact
 * endpoint `use-packet-transcript-poll.ts` and `SpawnedAgentHoverCard.tsx` poll.
 *
 * The hook exposes the RAW normalized `TranscriptEvent[]` tail (not a
 * pre-flattened line list) so the card can fold it into the IDE's rich block
 * vocabulary — tool-call pill clusters, turn summaries, running indicators — via
 * `buildAgentTranscriptBlocks` in `agent-transcript-blocks.tsx`. Reading the
 * exact same normalized structure the IDE reads keeps both sides rendering
 * identical truth.
 *
 * The canvas preview surface is NOT wrapped in OrchestratorDataProvider, so we
 * can't lift the IDE's hook (it resolves live status from that context); instead
 * this takes the live/terminal signal from the card's own lane row.
 */

import { useEffect, useRef, useState } from 'react';
import type { TranscriptEvent } from '@/lib/orchestrator/transcript-normalizer';

const POLL_MS = 3_000;
const TAIL_LIMIT = 200;

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

export type AgentTranscriptStatus = 'idle' | 'loading' | 'loaded' | 'empty' | 'unavailable';

export interface AgentTranscriptState {
  /** The raw normalized transcript tail — folded into blocks by the card. */
  events: TranscriptEvent[];
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
  const [events, setEvents] = useState<TranscriptEvent[]>([]);
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
        const next = payload.events;
        hasLoadedRef.current = true;
        setEvents(next);
        setStatus(next.length > 0 ? 'loaded' : 'empty');
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

  return { events, status };
}
