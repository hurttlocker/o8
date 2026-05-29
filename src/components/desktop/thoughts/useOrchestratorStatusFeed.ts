'use client';

import { useCallback, useEffect, useRef } from 'react';
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

// Grace window for the chat-driven rotation path to claim a just-completed
// mission before the dispatched fallback cards it (avoids double-carding a
// chat-driven mission). Imperceptible for the dispatched case.
const MISSION_CARD_CLAIM_GRACE_MS = 1200;

interface TrackedPacketMeta {
  title: string;
  referenceLabel: string;
  laneId: string | null;
  sessionKey: string | null;
}

interface MissionTracker {
  missionId: string;
  summary: string;
  repoPath: string | null;
  packetIds: Set<string>;
  done: Set<string>;
  meta: Map<string, TrackedPacketMeta>;
}

// Module-level (not hook-tracked, so mutation is allowed + survives the server
// clearing the current-mission pointer after archival). Keyed by missionId so
// concurrent missions don't collide. Cleared once the mission is carded.
const missionTrackers = new Map<string, MissionTracker>();

function packetIsTerminal(packet: OrchestratorPacket): boolean {
  return packet.releaseState === 'released' || Boolean(packet.archivedAt);
}

/**
 * Listens for `o8:lane-lifecycle` realtime events while the orchestrator tab is
 * active and appends a status card to the transcript when a packet MERGES or a
 * lane SELF-HEALS / needs a human.
 *
 * It ALSO delivers the "Mission complete" card — as a non-destructive, persistent
 * append — for MCP-dispatched missions, which the chat-driven rotation path
 * (showMissionThreadTransition) never sees. Detection can't rely on a snapshot of
 * the mission state: the server CLEARS the current-mission pointer right after a
 * mission archives, so the terminal-with-packets state is transient. Instead we
 * CAPTURE the mission's packet set while it's in flight (into a module-level
 * tracker that outlives the clear) and mark packets done from the per-packet
 * lifecycle `completed` events (the same durable signal the merge cards use).
 * When every captured packet is done we wait a short grace window — letting the
 * chat path claim a chat-driven mission first via the shared cardedMissionIds
 * set — then append the card.
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
  const seenRef = useRef<Set<string>>(new Set());
  const graceTimerRef = useRef<number | null>(null);

  // Keep the latest values in refs (updated in an effect, not during render)
  // so the long-lived lane-lifecycle listener always reads current state
  // without re-subscribing on every render.
  useEffect(() => {
    packetsRef.current = missionPackets;
    appendRef.current = appendLocalEntries;
    repoRef.current = repoPath;
  });

  const fireMissionComplete = useCallback((tracker: MissionTracker) => {
    if (hasMissionBeenCarded(tracker.missionId)) {
      missionTrackers.delete(tracker.missionId);
      return;
    }
    markMissionCarded(tracker.missionId);

    const packets = [...tracker.packetIds].map((id) => {
      const meta = tracker.meta.get(id);
      return { id, title: meta?.title ?? 'Packet', referenceLabel: meta?.referenceLabel };
    });
    const statusEvent: OrchestratorStatusEventData = {
      kind: 'mission-complete',
      mergedCount: packets.length,
      archivedCount: packets.length,
      summary: tracker.summary || undefined,
      repoPath: tracker.repoPath,
      packets,
    };
    const now = Date.now();
    appendRef.current([{
      id: `orch-mission-complete-${tracker.missionId}`,
      role: 'system',
      text: statusEventToText(statusEvent),
      timestamp: now,
      timestampLabel: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      statusEvent,
    }]);
    missionTrackers.delete(tracker.missionId);
  }, []);

  const scheduleMissionCompleteCheck = useCallback((missionKey: string) => {
    const tracker = missionTrackers.get(missionKey);
    if (!tracker || tracker.packetIds.size === 0) return;
    if (hasMissionBeenCarded(missionKey)) return;
    if (![...tracker.packetIds].every((id) => tracker.done.has(id))) return;
    if (graceTimerRef.current != null) return;
    graceTimerRef.current = window.setTimeout(() => {
      graceTimerRef.current = null;
      const current = missionTrackers.get(missionKey);
      if (current) fireMissionComplete(current);
    }, MISSION_CARD_CLAIM_GRACE_MS);
  }, [fireMissionComplete]);

  // Capture the in-flight mission's packet set (+ lane refs for event matching)
  // and fold in any packets already terminal. Runs whenever the mission state
  // updates — i.e. while the mission is still populated, before the clear.
  useEffect(() => {
    const id = missionId?.trim();
    if (!id || missionPackets.length === 0) return;
    const existing = missionTrackers.get(id);
    const tracker: MissionTracker = existing ?? {
      missionId: id,
      summary: missionSummary,
      repoPath,
      packetIds: new Set<string>(),
      done: new Set<string>(),
      meta: new Map<string, TrackedPacketMeta>(),
    };
    tracker.summary = missionSummary || tracker.summary;
    tracker.repoPath = repoPath ?? tracker.repoPath;
    for (const packet of missionPackets) {
      tracker.packetIds.add(packet.id);
      tracker.meta.set(packet.id, {
        title: packet.title,
        referenceLabel: packet.referenceLabel,
        laneId: packet.lane?.laneId ?? null,
        sessionKey: packet.lane?.sessionKey ?? null,
      });
      if (packetIsTerminal(packet)) tracker.done.add(packet.id);
    }
    missionTrackers.set(id, tracker);
    scheduleMissionCompleteCheck(id);
  }, [missionId, missionPackets, missionSummary, repoPath, scheduleMissionCompleteCheck]);

  useEffect(() => {
    if (!active) return undefined;
    const handler = (event: Event) => {
      const data = (event as CustomEvent<{ data?: LaneLifecycleDetailData }>).detail?.data;
      if (!data) return;
      // Scope to this orchestrator's repo (mirrors the mission-complete path).
      const evtRepo = normalizeRepoPath(data.repoPath);
      const myRepo = normalizeRepoPath(repoRef.current);
      if (evtRepo && myRepo && evtRepo !== myRepo) return;

      // Advance the mission-complete tracker when a packet's lane completes —
      // the durable per-packet signal that survives the mission-state clear.
      if (data.laneStatus === 'completed') {
        for (const [missionKey, tracker] of missionTrackers) {
          let packetId = data.packetId && tracker.packetIds.has(data.packetId) ? data.packetId : null;
          if (!packetId) {
            for (const [id, meta] of tracker.meta) {
              if ((data.laneId && meta.laneId === data.laneId) || (data.sessionKey && meta.sessionKey === data.sessionKey)) {
                packetId = id;
                break;
              }
            }
          }
          if (packetId) {
            tracker.done.add(packetId);
            scheduleMissionCompleteCheck(missionKey);
            break;
          }
        }
      }

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
  }, [active, scheduleMissionCompleteCheck]);

  useEffect(() => () => {
    if (graceTimerRef.current != null) window.clearTimeout(graceTimerRef.current);
  }, []);
}
