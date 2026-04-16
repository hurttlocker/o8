'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

interface LaneRecord {
  id: string;
  sessionKey: string | null;
  packetId: string | null;
  status: string;
}

interface LaneLifecycleEventData {
  laneId?: string;
  sessionKey?: string | null;
  packetId?: string | null;
  laneStatus?: string;
  previousStatus?: string | null;
}

export interface ArchivedLaneView {
  sessionKeys: Set<string>;
  packetIds: Set<string>;
}

// Fetches all lanes and exposes the sessionKeys + packetIds that belong to
// lanes in `archived` status. Subscribes to the realtime lane lifecycle
// window event so a refetch fires whenever a lane transitions.
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
      for (const lane of data.lanes ?? []) {
        if (lane.status !== 'archived') continue;
        if (lane.sessionKey) nextSessions.add(lane.sessionKey);
        if (lane.packetId) nextPackets.add(lane.packetId);
        const accumulated = laneSessionKeysRef.current.get(lane.id);
        if (accumulated) {
          for (const key of accumulated) nextSessions.add(key);
        }
      }
      setState((current) => {
        const sessionsSame = current.sessionKeys.size === nextSessions.size
          && [...nextSessions].every((key) => current.sessionKeys.has(key));
        const packetsSame = current.packetIds.size === nextPackets.size
          && [...nextPackets].every((id) => current.packetIds.has(id));
        return sessionsSame && packetsSame
          ? current
          : { sessionKeys: nextSessions, packetIds: nextPackets };
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
      if (data?.laneStatus === 'archived') {
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
          return changed ? { sessionKeys: sessions, packetIds: packets } : current;
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
