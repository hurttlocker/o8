'use client';

/**
 * Agent summary for the packet review header (Q ruling 2026-07-18, Codex
 * PR-view parity): the operator wants the agent's PROSE first — what it did,
 * in its own words — above the file rows and the diff. Resolves the lane →
 * packetId, then reads the packet transcript tail and lifts the last
 * assistant message as the summary. Best-effort: a missing transcript
 * degrades to no prose (the header still shows the file summary).
 */

import { useEffect, useState } from 'react';

interface LaneRecordResponse {
  lane?: { packetId?: string | null; label?: string | null; status?: string | null; sessionKey?: string | null } | null;
}

interface RuntimeTranscriptEntry {
  role?: string;
  text?: string;
}

interface RuntimeTranscriptResponse {
  transcript?: RuntimeTranscriptEntry[];
}

export interface LaneReviewSummaryState {
  title: string | null;
  summary: string | null;
  loading: boolean;
}

const EMPTY: LaneReviewSummaryState = { title: null, summary: null, loading: false };

export function useLaneReviewSummary(laneId?: string | null): LaneReviewSummaryState {
  const [state, setState] = useState<LaneReviewSummaryState>(() => (
    laneId ? { title: null, summary: null, loading: true } : EMPTY
  ));

  useEffect(() => {
    if (!laneId) {
      setState(EMPTY);
      return;
    }
    let cancelled = false;
    setState({ title: null, summary: null, loading: true });
    (async () => {
      let title: string | null = null;
      let summary: string | null = null;
      try {
        const laneRes = await fetch(`/api/lanes/${encodeURIComponent(laneId)}`, { cache: 'no-store' });
        const laneData = await laneRes.json().catch(() => null) as LaneRecordResponse | null;
        const sessionKey = laneData?.lane?.sessionKey ?? null;
        title = laneData?.lane?.label ?? null;
        if (sessionKey) {
          // The runtime transcript is the same source the packet tab renders —
          // the packet-transcript route's control-plane resolution comes up
          // empty for delegate-synthesized packets (#1389 class).
          const params = new URLSearchParams({ sessionKey, limit: '40' });
          const trRes = await fetch(`/api/runtime/transcript?${params.toString()}`, { cache: 'no-store' });
          const trData = await trRes.json().catch(() => null) as RuntimeTranscriptResponse | null;
          const entries = Array.isArray(trData?.transcript) ? trData.transcript : [];
          for (let i = entries.length - 1; i >= 0; i--) {
            const entry = entries[i];
            if (entry?.role === 'assistant' && typeof entry.text === 'string' && entry.text.trim().length > 0) {
              summary = entry.text.trim();
              break;
            }
          }
        }
      } catch {
        // best-effort — header degrades to the file summary alone
      }
      if (!cancelled) setState({ title, summary, loading: false });
    })();
    return () => { cancelled = true; };
  }, [laneId]);

  return state;
}
