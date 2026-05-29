'use client';

import { useEffect, useRef } from 'react';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import {
  deriveLaneStatusEvent,
  statusEventDedupeKey,
  statusEventToText,
  type LaneLifecyclePayload,
} from '@/lib/orchestrator/status-events';
import { normalizeRepoPath } from './use-orchestrator-stream/shared';

interface LaneLifecycleDetailData extends LaneLifecyclePayload {
  repoPath?: string | null;
  timestamp?: string;
}

interface UseOrchestratorStatusFeedOptions {
  active: boolean;
  repoPath: string | null;
  missionPackets: OrchestratorPacket[];
  appendLocalEntries: (entries: MobileTranscriptEntry[]) => void;
}

/**
 * Listens for `o8:lane-lifecycle` realtime events while the orchestrator tab is
 * active and appends a status card to the transcript when a packet MERGES or a
 * lane SELF-HEALS / needs a human. Mission-complete is handled separately (via
 * the mission-completed event in useOrchestratorStream); this covers the
 * per-packet lifecycle moments.
 *
 * Dedupe is per transition for the session. Lifecycle events fire once in
 * realtime (not replayed on load), so reloads don't re-card — the entries that
 * were appended live persist in the saved thread like any other message.
 */
export function useOrchestratorStatusFeed({
  active,
  repoPath,
  missionPackets,
  appendLocalEntries,
}: UseOrchestratorStatusFeedOptions) {
  const packetsRef = useRef(missionPackets);
  const appendRef = useRef(appendLocalEntries);
  const repoRef = useRef(repoPath);
  const seenRef = useRef<Set<string>>(new Set());

  // Keep the latest values in refs (updated in an effect, not during render)
  // so the long-lived lane-lifecycle listener always reads current state
  // without re-subscribing on every render.
  useEffect(() => {
    packetsRef.current = missionPackets;
    appendRef.current = appendLocalEntries;
    repoRef.current = repoPath;
  });

  useEffect(() => {
    if (!active) return undefined;
    const handler = (event: Event) => {
      const data = (event as CustomEvent<{ data?: LaneLifecycleDetailData }>).detail?.data;
      if (!data) return;
      // Scope to this orchestrator's repo (mirrors the mission-complete path).
      const evtRepo = normalizeRepoPath(data.repoPath);
      const myRepo = normalizeRepoPath(repoRef.current);
      if (evtRepo && myRepo && evtRepo !== myRepo) return;

      const resolveTitle = (payload: LaneLifecyclePayload): string | null => {
        const match = packetsRef.current.find((packet) => (
          (payload.packetId && packet.id === payload.packetId)
          || (payload.laneId && packet.lane?.laneId === payload.laneId)
          || (payload.sessionKey && packet.lane?.sessionKey === payload.sessionKey)
        ));
        return match?.title ?? null;
      };

      const statusEvent = deriveLaneStatusEvent(data, resolveTitle);
      if (!statusEvent) return;
      const key = statusEventDedupeKey(data, statusEvent);
      if (seenRef.current.has(key)) return;
      seenRef.current.add(key);

      const now = Date.now();
      appendRef.current([{
        id: `orch-status-${key}-${now}`,
        role: 'system',
        text: statusEventToText(statusEvent),
        timestamp: now,
        timestampLabel: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        statusEvent,
      }]);
    };
    window.addEventListener('o8:lane-lifecycle', handler);
    return () => window.removeEventListener('o8:lane-lifecycle', handler);
  }, [active]);
}
