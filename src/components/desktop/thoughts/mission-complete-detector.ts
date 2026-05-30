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
// Recorded Mission-complete cards. NOT consumed on read — kept here so the feed
// can RE-ASSERT them (idempotent append-by-id) after a thread reload clobbers
// the live transcript. Capped; superseded per repo by newer missions.
const pendingCards: MobileTranscriptEntry[] = [];
const MAX_PENDING_CARDS = 12;
// Skip redundant capture work when the mission snapshot is unchanged (the
// capture effect re-runs on every render because missionState is a fresh ref).
const lastCaptureSig = new Map<string, string>();

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
  const cardId = `orch-mission-complete-${tracker.missionId}`;
  if (!pendingCards.some((card) => card.id === cardId)) {
    pendingCards.push({
      id: cardId,
      role: 'system',
      text: statusEventToText(statusEvent),
      timestamp: Date.now(),
      timestampLabel: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      statusEvent,
    });
    while (pendingCards.length > MAX_PENDING_CARDS) pendingCards.shift();
  }
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
 * Return (WITHOUT removing) the Mission-complete cards recorded for `repoPath`.
 * Non-consuming so the feed can re-assert them after a thread reload clobbers
 * the live transcript — appendLocalEntries dedups by id, so re-asserting is a
 * no-op once the card is present.
 */
export function getPendingMissionCards(repoPath: string | null): MobileTranscriptEntry[] {
  if (pendingCards.length === 0) return [];
  const target = normalizeRepoPath(repoPath);
  return pendingCards.filter((card) => {
    const event = card.statusEvent;
    const cardRepo = normalizeRepoPath(event && event.kind === 'mission-complete' ? event.repoPath ?? null : null);
    return !target || !cardRepo || cardRepo === target;
  });
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
    // Skip when this mission's packet/release snapshot is unchanged — the effect
    // re-runs on every render (missionState is a fresh ref each time).
    const sig = missionState.packets.map((p) => `${p.id}:${p.releaseState}:${p.archivedAt ? 1 : 0}`).join('|');
    if (lastCaptureSig.get(id) === sig) return;
    lastCaptureSig.set(id, sig);
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
