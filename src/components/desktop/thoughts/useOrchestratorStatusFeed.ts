'use client';

import { useEffect, useRef } from 'react';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import { hasMissionBeenCarded, markMissionCarded } from '@/lib/orchestrator/store';
import {
  deriveLaneStatusEvent,
  statusEventDedupeKey,
  statusEventToText,
  type LaneLifecyclePayload,
  type OrchestratorStatusEventData,
} from '@/lib/orchestrator/status-events';
import { normalizeRepoPath } from './use-orchestrator-stream/shared';

interface LaneLifecycleDetailData extends LaneLifecyclePayload {
  repoPath?: string | null;
  timestamp?: string;
}

interface UseOrchestratorStatusFeedOptions {
  active: boolean;
  repoPath: string | null;
  missionId: string | null;
  missionSummary: string;
  missionPackets: OrchestratorPacket[];
  appendLocalEntries: (entries: MobileTranscriptEntry[]) => void;
}

// Don't card a mission that completed in a prior session (e.g. the last
// terminal mission loaded on launch / when the tab first becomes active).
const MISSION_CARD_RECENCY_MS = 15 * 60 * 1000;
// Grace window for the chat-driven rotation path to claim a just-completed
// mission before the dispatched fallback cards it (avoids double-carding a
// chat-driven mission). Imperceptible for the dispatched case.
const MISSION_CARD_CLAIM_GRACE_MS = 1000;

function packetIsTerminal(packet: OrchestratorPacket): boolean {
  return packet.releaseState === 'released' || Boolean(packet.archivedAt);
}

/**
 * Listens for `o8:lane-lifecycle` realtime events while the orchestrator tab is
 * active and appends a status card to the transcript when a packet MERGES or a
 * lane SELF-HEALS / needs a human.
 *
 * It ALSO delivers the "Mission complete" card — as a non-destructive, persistent
 * append — when every packet of the mission reaches a terminal state. This is the
 * fallback path for MCP-dispatched missions, which the chat-driven rotation path
 * (showMissionThreadTransition) never sees. A shared carded-mission set + a short
 * claim grace window let the chat path win when it's active so neither double-cards.
 *
 * Dedupe is per transition for the session. Lifecycle events fire once in
 * realtime (not replayed on load), so reloads don't re-card; the mission-complete
 * effect re-checks on `active` toggles so opening the tab after a recent dispatched
 * completion still cards it.
 */
export function useOrchestratorStatusFeed({
  active,
  repoPath,
  missionId,
  missionSummary,
  missionPackets,
  appendLocalEntries,
}: UseOrchestratorStatusFeedOptions) {
  const packetsRef = useRef(missionPackets);
  const appendRef = useRef(appendLocalEntries);
  const repoRef = useRef(repoPath);
  const summaryRef = useRef(missionSummary);
  const seenRef = useRef<Set<string>>(new Set());
  const missionCardedRef = useRef<Set<string>>(new Set());

  // Keep the latest values in refs (updated in an effect, not during render)
  // so the long-lived lane-lifecycle listener always reads current state
  // without re-subscribing on every render.
  useEffect(() => {
    packetsRef.current = missionPackets;
    appendRef.current = appendLocalEntries;
    repoRef.current = repoPath;
    summaryRef.current = missionSummary;
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

  // Mission-complete fallback (dispatched missions). Fires when every packet is
  // terminal, the mission is recent, and the chat path hasn't claimed it.
  useEffect(() => {
    if (!active) return undefined;
    const id = missionId?.trim();
    if (!id) return undefined;
    const packets = missionPackets;
    if (packets.length === 0 || !packets.every(packetIsTerminal)) return undefined;
    if (missionCardedRef.current.has(id) || hasMissionBeenCarded(id)) return undefined;

    const completedAt = packets.reduce((latest, packet) => {
      const candidate = packet.archivedAt ?? packet.lastEventAt ?? packet.review?.recordedAt ?? '';
      return candidate > latest ? candidate : latest;
    }, '');
    const completedMs = completedAt ? Date.parse(completedAt) : Number.NaN;
    if (Number.isFinite(completedMs) && Date.now() - completedMs > MISSION_CARD_RECENCY_MS) return undefined;

    const timer = window.setTimeout(() => {
      if (missionCardedRef.current.has(id) || hasMissionBeenCarded(id)) return;
      missionCardedRef.current.add(id);
      markMissionCarded(id);

      const released = packets.filter((packet) => packet.releaseState === 'released');
      const statusEvent: OrchestratorStatusEventData = {
        kind: 'mission-complete',
        mergedCount: released.length,
        archivedCount: packets.filter((packet) => Boolean(packet.archivedAt)).length,
        summary: summaryRef.current || undefined,
        repoPath: repoRef.current,
        packets: released.map((packet) => ({
          id: packet.id,
          title: packet.title,
          referenceLabel: packet.referenceLabel,
        })),
      };
      const now = Date.now();
      appendRef.current([{
        id: `orch-mission-complete-${id}`,
        role: 'system',
        text: statusEventToText(statusEvent),
        timestamp: now,
        timestampLabel: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        statusEvent,
      }]);
    }, MISSION_CARD_CLAIM_GRACE_MS);

    return () => window.clearTimeout(timer);
  }, [active, missionId, missionPackets]);
}
