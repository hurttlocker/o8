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
import { getPendingMissionCards, MISSION_CARD_READY_EVENT } from './mission-complete-detector';
import { normalizeRepoPath } from './use-orchestrator-stream/shared';

interface LaneLifecycleDetailData extends LaneLifecyclePayload {
  repoPath?: string | null;
  timestamp?: string;
}

interface UseOrchestratorStatusFeedOptions {
  active: boolean;
  repoPath: string | null;
  threadId: string | null;
  missionPackets: OrchestratorPacket[];
  appendLocalEntries: (entries: MobileTranscriptEntry[]) => void;
}

/**
 * While the orchestrator tab is active, this hook (1) appends per-packet
 * MERGE / SELF-HEAL status cards from `o8:lane-lifecycle` events, and (2) drains
 * the durable Mission-complete cards recorded by the always-mounted
 * `useMissionCompleteDetector` into the transcript (where they auto-persist).
 *
 * Mission-complete detection lives in the detector — NOT here — because it must
 * survive this tab's active/mode flapping and the server clearing the mission
 * state. This hook only delivers the recorded card into the visible transcript.
 *
 * Dedupe for the per-packet cards is per transition for the session; lifecycle
 * events fire once in realtime (no replay on load), so reloads don't re-card.
 */
export function useOrchestratorStatusFeed({
  active,
  repoPath,
  threadId,
  missionPackets,
  appendLocalEntries,
}: UseOrchestratorStatusFeedOptions) {
  const packetsRef = useRef(missionPackets);
  const appendRef = useRef(appendLocalEntries);
  const repoRef = useRef(repoPath);
  const threadRef = useRef(threadId);
  const seenRef = useRef<Set<string>>(new Set());

  // Keep the latest values in refs (updated in an effect, not during render)
  // so the long-lived lane-lifecycle listener always reads current state
  // without re-subscribing on every render.
  useEffect(() => {
    packetsRef.current = missionPackets;
    appendRef.current = appendLocalEntries;
    repoRef.current = repoPath;
    threadRef.current = threadId;
  });

  // Surface Mission-complete cards recorded by the detector. The detector
  // consumes cards on read, so a completed mission is delivered to one owning
  // transcript and cannot later re-emit into a fresh thread for the same repo.
  useEffect(() => {
    if (!active) return undefined;
    const assert = () => {
      const cards = getPendingMissionCards(repoRef.current, threadRef.current);
      if (cards.length > 0) appendRef.current(cards);
    };
    assert();
    window.addEventListener(MISSION_CARD_READY_EVENT, assert);
    return () => window.removeEventListener(MISSION_CARD_READY_EVENT, assert);
  }, [active, repoPath, threadId]);

  // Per-packet merge / self-heal cards.
  useEffect(() => {
    if (!active) return undefined;
    const handler = (event: Event) => {
      const data = (event as CustomEvent<{ data?: LaneLifecycleDetailData }>).detail?.data;
      if (!data) return;
      // Scope to this orchestrator's repo.
      const evtRepo = normalizeRepoPath(data.repoPath);
      const myRepo = normalizeRepoPath(repoRef.current);
      if (evtRepo && myRepo && evtRepo !== myRepo) return;

      const resolvePacket = (payload: LaneLifecyclePayload) => {
        const match = packetsRef.current.find((packet) => (
          (payload.packetId && packet.id === payload.packetId)
          || (payload.laneId && packet.lane?.laneId === payload.laneId)
          || (payload.sessionKey && packet.lane?.sessionKey === payload.sessionKey)
        ));
        if (!match) return null;
        return {
          title: match.title,
          repoLabel: match.workspaceTargetPath?.split('/').filter(Boolean).pop() ?? null,
          diff: null,
          focus: {
            packetId: match.id,
            laneId: match.lane?.laneId ?? payload.laneId ?? null,
            sessionKey: match.lane?.sessionKey ?? match.lane?.tabId ?? payload.sessionKey ?? null,
          },
        };
      };

      const statusEvent = deriveLaneStatusEvent(data, resolvePacket);
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
