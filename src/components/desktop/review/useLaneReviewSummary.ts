'use client';

/**
 * Agent summary for the packet review header (Q ruling 2026-07-18, Codex
 * PR-view parity): the operator wants the agent's PROSE first — what it did,
 * in its own words — above the file rows and the diff. Resolves the lane →
 * sessionKey/packetId, then reads the runtime transcript tail and lifts the
 * last assistant message as the summary. Best-effort: a missing transcript
 * degrades to no prose (the header still shows the file summary).
 */

import { useCallback, useEffect, useState } from 'react';

interface LaneRecordResponse {
  lane?: {
    packetId?: string | null;
    label?: string | null;
    status?: string | null;
    sessionKey?: string | null;
  } | null;
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
  packetId: string | null;
  laneStatus: string | null;
  loading: boolean;
  refreshStatus: () => Promise<string | null>;
}

export function useLaneReviewSummary(laneId?: string | null): LaneReviewSummaryState {
  const [title, setTitle] = useState<string | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [packetId, setPacketId] = useState<string | null>(null);
  const [laneStatus, setLaneStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(() => Boolean(laneId));

  // Cheap status re-read for the merge action's post-approve poll — returns
  // the fresh status so callers can await it without racing setState.
  const refreshStatus = useCallback(async (): Promise<string | null> => {
    if (!laneId) return null;
    try {
      const res = await fetch(`/api/lanes/${encodeURIComponent(laneId)}`, { cache: 'no-store' });
      const data = await res.json().catch(() => null) as LaneRecordResponse | null;
      const status = data?.lane?.status ?? null;
      setLaneStatus(status);
      return status;
    } catch {
      return null;
    }
  }, [laneId]);

  useEffect(() => {
    if (!laneId) {
      setTitle(null);
      setSummary(null);
      setPacketId(null);
      setLaneStatus(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setSummary(null);
    (async () => {
      let nextTitle: string | null = null;
      let nextSummary: string | null = null;
      let nextPacketId: string | null = null;
      let nextStatus: string | null = null;
      try {
        const laneRes = await fetch(`/api/lanes/${encodeURIComponent(laneId)}`, { cache: 'no-store' });
        const laneData = await laneRes.json().catch(() => null) as LaneRecordResponse | null;
        const sessionKey = laneData?.lane?.sessionKey ?? null;
        nextTitle = laneData?.lane?.label ?? null;
        nextPacketId = laneData?.lane?.packetId ?? null;
        nextStatus = laneData?.lane?.status ?? null;
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
              nextSummary = entry.text.trim();
              break;
            }
          }
        }
      } catch {
        // best-effort — header degrades to the file summary alone
      }
      if (!cancelled) {
        setTitle(nextTitle);
        setSummary(nextSummary);
        setPacketId(nextPacketId);
        setLaneStatus(nextStatus);
        setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [laneId]);

  return { title, summary, packetId, laneStatus, loading, refreshStatus };
}
