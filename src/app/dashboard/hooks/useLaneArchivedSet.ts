'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

interface LaneRecord {
  id: string;
  sessionKey: string | null;
  packetId: string | null;
  status: string;
  archiveSummary?: LaneArchiveSummary | null;
}

interface LaneArchiveSummary {
  source: string;
  message: string;
  preservedBranch?: string | null;
  /** Durable lane outcome, when stamped — mirrors lane/archive-summary.ts. */
  outcome?: 'merged' | 'discarded' | 'no_changes' | null;
}

interface LaneLifecycleEventData {
  laneId?: string;
  sessionKey?: string | null;
  packetId?: string | null;
  // The live WS payload carries the lane status as `status`; `laneStatus` is the
  // legacy/realtime-envelope name. Read both (see laneStatusOf in status-events).
  status?: string;
  laneStatus?: string;
  previousStatus?: string | null;
}

export interface ArchivedLaneView {
  sessionKeys: Set<string>;
  packetIds: Set<string>;
  archiveSummariesBySessionKey: Map<string, LaneArchiveSummary>;
  archiveSummariesByPacketId: Map<string, LaneArchiveSummary>;
}

function archiveSummarySame(left: LaneArchiveSummary | undefined, right: LaneArchiveSummary | undefined): boolean {
  return left?.source === right?.source
    && left?.message === right?.message
    && left?.preservedBranch === right?.preservedBranch;
}

function archiveSummaryMapsSame(
  left: Map<string, LaneArchiveSummary>,
  right: Map<string, LaneArchiveSummary>,
): boolean {
  return left.size === right.size
    && [...right].every(([key, value]) => archiveSummarySame(left.get(key), value));
}

// Terminal lane statuses that mean "retired" — the session is done and the
// tab should be read-only. `archived` is the normal post-merge state, but the
// governance-override merge path (o8_approve → merge) leaves a lane at
// `completed`: it merged yet never transitioned to `archived`. Both are
// inactive (the Codex process has exited), so we treat them the same —
// otherwise an override-merged packet's tab stays stuck on "Agent working…"
// with a live steer composer while its sibling (normal merge) reads as merged.
export const RETIRED_LANE_STATUSES = new Set(['archived', 'completed']);

/** True when a lane-lifecycle status means the lane is retired (done — the
 *  worker process has exited). Drives read-only views AND closing the orphaned
 *  workspace tab (#1293). */
export function isRetiredLaneStatus(status: string | null | undefined): boolean {
  return Boolean(status) && RETIRED_LANE_STATUSES.has(status as string);
}

// Fetches all lanes and exposes the sessionKeys + packetIds that belong to
// lanes in a retired (`archived` / `completed`) status. Subscribes to the
// realtime lane lifecycle window event so a refetch fires whenever a lane
// transitions.
//
// #542 — A supervisor retry loop binds multiple sessionKeys to the same
// lane over its lifetime. By the time the lane archives, `lane.sessionKey`
// is usually just the last one (or null, since some transitions clear it).
// The API-only view therefore misses the intermediate retry sessionKeys,
// leaving ghost agent rows in the sidebar.
//
// We layer an event-driven accumulator on top: every lane-lifecycle broadcast
// includes `sessionKey` in its payload. We collect ALL sessionKeys we've
// ever seen for each laneId, then when any lane archives we union its
// accumulated keys into the archived set. The API fetch is still the
// source of truth for packets + post-reload state (the accumulator resets
// on mount), but the accumulator catches within-session ghosts.
//
// Used by the sidebar to hide session cards and orchestrator packet chips
// whose lanes have been retired — packet dispatches that shipped, manual
// launches whose branches merged into base, and reaper-cleaned orphans.
export function useLaneArchivedView(): ArchivedLaneView {
  const [state, setState] = useState<ArchivedLaneView>(() => ({
    sessionKeys: new Set<string>(),
    packetIds: new Set<string>(),
    archiveSummariesBySessionKey: new Map<string, LaneArchiveSummary>(),
    archiveSummariesByPacketId: new Map<string, LaneArchiveSummary>(),
  }));
  const inflightRef = useRef(false);
  const laneSessionKeysRef = useRef<Map<string, Set<string>>>(new Map());

  const fetchOnce = useCallback(async () => {
    if (inflightRef.current) return;
    inflightRef.current = true;
    try {
      const response = await fetch('/api/lanes?active=false', { cache: 'no-store' });
      if (!response.ok) return;
      const data = await response.json() as { lanes?: LaneRecord[] };
      const nextSessions = new Set<string>();
      const nextPackets = new Set<string>();
      const nextSessionSummaries = new Map<string, LaneArchiveSummary>();
      const nextPacketSummaries = new Map<string, LaneArchiveSummary>();
      for (const lane of data.lanes ?? []) {
        if (!RETIRED_LANE_STATUSES.has(lane.status)) continue;
        if (lane.sessionKey) nextSessions.add(lane.sessionKey);
        if (lane.packetId) nextPackets.add(lane.packetId);
        if (lane.archiveSummary) {
          if (lane.sessionKey) nextSessionSummaries.set(lane.sessionKey, lane.archiveSummary);
          if (lane.packetId) nextPacketSummaries.set(lane.packetId, lane.archiveSummary);
        }
        const accumulated = laneSessionKeysRef.current.get(lane.id);
        if (accumulated) {
          for (const key of accumulated) {
            nextSessions.add(key);
            if (lane.archiveSummary) nextSessionSummaries.set(key, lane.archiveSummary);
          }
        }
      }
      setState((current) => {
        const sessionsSame = current.sessionKeys.size === nextSessions.size
          && [...nextSessions].every((key) => current.sessionKeys.has(key));
        const packetsSame = current.packetIds.size === nextPackets.size
          && [...nextPackets].every((id) => current.packetIds.has(id));
        const sessionSummariesSame = archiveSummaryMapsSame(current.archiveSummariesBySessionKey, nextSessionSummaries);
        const packetSummariesSame = archiveSummaryMapsSame(current.archiveSummariesByPacketId, nextPacketSummaries);
        return sessionsSame && packetsSame && sessionSummariesSame && packetSummariesSame
          ? current
          : {
              sessionKeys: nextSessions,
              packetIds: nextPackets,
              archiveSummariesBySessionKey: nextSessionSummaries,
              archiveSummariesByPacketId: nextPacketSummaries,
            };
      });
    } catch {
      // Lane derivation is best-effort — on fetch failure we keep the last
      // known view and let the next realtime event or retry reconcile.
    } finally {
      inflightRef.current = false;
    }
  }, []);

  useEffect(() => {
    void fetchOnce();
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ data?: LaneLifecycleEventData }>).detail;
      const data = detail?.data;
      if (data?.laneId && data.sessionKey) {
        // Accumulate every sessionKey we see bound to this lane — retries
        // swap sessionKeys behind the scenes, and by the time `archived`
        // fires we need the whole history to hide every ghost session card.
        let keys = laneSessionKeysRef.current.get(data.laneId);
        if (!keys) {
          keys = new Set<string>();
          laneSessionKeysRef.current.set(data.laneId, keys);
        }
        keys.add(data.sessionKey);
      }
      const eventLaneStatus = data?.laneStatus ?? data?.status;
      if (data && eventLaneStatus && RETIRED_LANE_STATUSES.has(eventLaneStatus)) {
        const keys = data.laneId ? laneSessionKeysRef.current.get(data.laneId) : null;
        const packetId = data.packetId ?? null;
        setState((current) => {
          let changed = false;
          const sessions = new Set(current.sessionKeys);
          const packets = new Set(current.packetIds);
          if (keys) {
            for (const key of keys) {
              if (!sessions.has(key)) {
                sessions.add(key);
                changed = true;
              }
            }
          }
          if (data.sessionKey && !sessions.has(data.sessionKey)) {
            sessions.add(data.sessionKey);
            changed = true;
          }
          if (packetId && !packets.has(packetId)) {
            packets.add(packetId);
            changed = true;
          }
          return changed ? { ...current, sessionKeys: sessions, packetIds: packets } : current;
        });
      }
      void fetchOnce();
    };
    window.addEventListener('o8:lane-lifecycle', handler);
    return () => window.removeEventListener('o8:lane-lifecycle', handler);
  }, [fetchOnce]);

  return state;
}

// Backwards-compatible shim while callers migrate to useLaneArchivedView.
export function useLaneArchivedSet(): Set<string> {
  const view = useLaneArchivedView();
  return useMemo(() => view.sessionKeys, [view.sessionKeys]);
}
