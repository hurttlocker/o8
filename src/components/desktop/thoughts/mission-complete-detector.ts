'use client';

import { useEffect } from 'react';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import type { OrchestratorMissionState, OrchestratorPacket } from '@/lib/orchestrator/types';
import { hasMissionBeenCarded, markMissionCarded } from '@/lib/orchestrator/store';
import {
  laneStatusOf,
  statusEventToText,
  type LaneLifecyclePayload,
  type OrchestratorStatusEventData,
} from '@/lib/orchestrator/status-events';
import { normalizeRepoPath } from './use-orchestrator-stream/shared';

/** Fired when a Mission-complete card is recorded and ready for a transcript to drain. */
export const MISSION_CARD_READY_EVENT = 'o8:mission-card-ready';

interface LaneLifecycleDetailData extends LaneLifecyclePayload {
  repoPath?: string | null;
}

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

// Module-level so the detector accumulates across the orchestrator tab's
// mode/active flapping AND the server clearing the current-mission pointer
// after archival. Pending cards wait here until a live transcript drains them.
const trackers = new Map<string, MissionTracker>();
const pendingCards: MobileTranscriptEntry[] = [];

function packetIsTerminal(packet: OrchestratorPacket): boolean {
  return packet.releaseState === 'released' || Boolean(packet.archivedAt);
}

function recordPendingMissionCard(tracker: MissionTracker) {
  if (hasMissionBeenCarded(tracker.missionId)) {
    trackers.delete(tracker.missionId);
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
  pendingCards.push({
    id: `orch-mission-complete-${tracker.missionId}`,
    role: 'system',
    text: statusEventToText(statusEvent),
    timestamp: Date.now(),
    timestampLabel: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    statusEvent,
  });
  trackers.delete(tracker.missionId);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(MISSION_CARD_READY_EVENT));
  }
}

function checkTrackerComplete(missionId: string) {
  const tracker = trackers.get(missionId);
  if (!tracker || tracker.packetIds.size === 0) return;
  if (![...tracker.packetIds].every((id) => tracker.done.has(id))) return;
  recordPendingMissionCard(tracker);
}

/**
 * Drain the Mission-complete cards recorded for `repoPath` (returns + removes
 * them). Cards with no repoPath, or a matching one, are returned.
 */
export function drainPendingMissionCards(repoPath: string | null): MobileTranscriptEntry[] {
  if (pendingCards.length === 0) return [];
  const target = normalizeRepoPath(repoPath);
  const drained: MobileTranscriptEntry[] = [];
  for (let i = pendingCards.length - 1; i >= 0; i -= 1) {
    const card = pendingCards[i];
    const event = card.statusEvent;
    const cardRepo = normalizeRepoPath(event && event.kind === 'mission-complete' ? event.repoPath ?? null : null);
    if (!target || !cardRepo || cardRepo === target) {
      drained.unshift(card);
      pendingCards.splice(i, 1);
    }
  }
  return drained;
}

/**
 * Always-mounted Mission-complete detector. Mount ONCE at the dashboard level
 * (it must outlive the orchestrator tab, which unmounts/flaps its active+mode).
 *
 * Captures the in-flight mission's packet set from `missionState` and marks
 * packets done from the durable lane-lifecycle `completed` events — both signals
 * are observed regardless of which workspace tab is focused. When every packet
 * is done it records a pending Mission-complete card (deduped via the shared
 * cardedMissionIds set) and fires MISSION_CARD_READY_EVENT; the orchestrator
 * feed drains the card into its transcript on view, where it auto-persists.
 */
export function useMissionCompleteDetector(missionState: OrchestratorMissionState | null | undefined) {
  // Capture the in-flight mission's packet set as the mission state updates.
  useEffect(() => {
    const id = missionState?.missionId?.trim();
    if (!id || !missionState || missionState.packets.length === 0) return;
    if (hasMissionBeenCarded(id)) return;
    const existing = trackers.get(id);
    const tracker: MissionTracker = existing ?? {
      missionId: id,
      summary: missionState.summary,
      repoPath: missionState.repoPath ?? null,
      packetIds: new Set<string>(),
      done: new Set<string>(),
      meta: new Map<string, TrackedPacketMeta>(),
    };
    tracker.summary = missionState.summary || tracker.summary;
    tracker.repoPath = missionState.repoPath ?? tracker.repoPath;
    for (const packet of missionState.packets) {
      tracker.packetIds.add(packet.id);
      tracker.meta.set(packet.id, {
        title: packet.title,
        referenceLabel: packet.referenceLabel,
        laneId: packet.lane?.laneId ?? null,
        sessionKey: packet.lane?.sessionKey ?? null,
      });
      if (packetIsTerminal(packet)) tracker.done.add(packet.id);
    }
    trackers.set(id, tracker);
    checkTrackerComplete(id);
  }, [missionState]);

  // Always-on lane-lifecycle listener (no active/mode gate → never misses the
  // completion event because a dispatch switched focus to the packet tab). The
  // handler reads only module-level state, so it's stable without a ref.
  useEffect(() => {
    const handler = (event: Event) => {
      const data = (event as CustomEvent<{ data?: LaneLifecycleDetailData }>).detail?.data;
      if (!data || laneStatusOf(data) !== 'completed') return;
      for (const [missionId, tracker] of trackers) {
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
          checkTrackerComplete(missionId);
          break;
        }
      }
    };
    window.addEventListener('o8:lane-lifecycle', handler);
    return () => window.removeEventListener('o8:lane-lifecycle', handler);
  }, []);
}
