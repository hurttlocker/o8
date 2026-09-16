import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchWithLongLivedBudget } from '@/lib/connection-budget';
import type { OrchestratorMissionState, OrchestratorStateApiResponse } from '@/lib/orchestrator/types';
import {
  createEmptyOrchestratorMissionState,
  loadOrchestratorMissionState,
  normalizeOrchestratorMissionState,
  ORCHESTRATOR_STATE_API_PATH,
  persistOrchestratorMissionState,
  readOrchestratorMissionState,
  subscribeOrchestratorMissionState,
  updateOrchestratorMissionState,
} from '@/lib/orchestrator/store';
import { removedOrchestratorPacketIds } from '@/lib/orchestrator/client-mission-removals';

const MISSION_STATE_LIFECYCLE_REFETCH_DEBOUNCE_MS = 350;

async function refetchOrchestratorMissionState(): Promise<OrchestratorMissionState | null> {
  try {
    const response = await fetchWithLongLivedBudget(ORCHESTRATOR_STATE_API_PATH, {
      cache: 'no-store',
      headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
    });
    if (!response.ok) return null;
    const payload = await response.json() as Partial<OrchestratorStateApiResponse>;
    const next = normalizeOrchestratorMissionState(payload.mission ?? createEmptyOrchestratorMissionState());
    return updateOrchestratorMissionState(next);
  } catch {
    return null;
  }
}

export function useOrchestratorMission() {
  const [thoughtsMissionState, setThoughtsMissionState] = useState<OrchestratorMissionState>(() => readOrchestratorMissionState());
  const thoughtsPersistTimerRef = useRef<number | null>(null);
  // Deletes made through handleThoughtsMissionStateChange since the last POST.
  // The debounce collapses several changes into one write, so they accumulate.
  const pendingRemovedPacketIdsRef = useRef(new Set<string>());

  useEffect(() => {
    return subscribeOrchestratorMissionState(setThoughtsMissionState);
  }, []);

  useEffect(() => {
    void loadOrchestratorMissionState().then(setThoughtsMissionState);
    const handleFocus = () => {
      void loadOrchestratorMissionState().then(setThoughtsMissionState);
    };
    window.addEventListener('focus', handleFocus);
    return () => window.removeEventListener('focus', handleFocus);
  }, []);

  useEffect(() => {
    let disposed = false;
    let inFlight = false;
    let queued = false;
    let timer: number | null = null;

    const run = async () => {
      if (inFlight) {
        queued = true;
        return;
      }
      inFlight = true;
      try {
        const next = await refetchOrchestratorMissionState();
        if (!disposed && next) setThoughtsMissionState(next);
      } finally {
        inFlight = false;
        if (queued && !disposed) {
          queued = false;
          schedule();
        }
      }
    };

    const schedule = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        void run();
      }, MISSION_STATE_LIFECYCLE_REFETCH_DEBOUNCE_MS);
    };

    const events = ['o8:lane-lifecycle', 'o8:agent-lifecycle'];
    for (const event of events) window.addEventListener(event, schedule);
    return () => {
      disposed = true;
      if (timer !== null) window.clearTimeout(timer);
      for (const event of events) window.removeEventListener(event, schedule);
    };
  }, []);

  useEffect(() => () => {
    if (thoughtsPersistTimerRef.current !== null) {
      window.clearTimeout(thoughtsPersistTimerRef.current);
    }
  }, []);

  const scheduleThoughtsMissionPersist = useCallback((next: OrchestratorMissionState) => {
    if (thoughtsPersistTimerRef.current !== null) {
      window.clearTimeout(thoughtsPersistTimerRef.current);
    }
    thoughtsPersistTimerRef.current = window.setTimeout(() => {
      thoughtsPersistTimerRef.current = null;
      const removedPacketIds = [...pendingRemovedPacketIdsRef.current];
      pendingRemovedPacketIdsRef.current.clear();
      void persistOrchestratorMissionState(next, removedPacketIds);
    }, 180);
  }, []);

  const handleThoughtsMissionStateChange = useCallback((
    next: OrchestratorMissionState | ((current: OrchestratorMissionState) => OrchestratorMissionState),
  ) => {
    const previous = readOrchestratorMissionState();
    const updated = updateOrchestratorMissionState(next);
    for (const id of removedOrchestratorPacketIds(previous, updated)) pendingRemovedPacketIdsRef.current.add(id);
    setThoughtsMissionState(updated);
    scheduleThoughtsMissionPersist(updated);
  }, [scheduleThoughtsMissionPersist]);

  return {
    handleThoughtsMissionStateChange,
    scheduleThoughtsMissionPersist,
    setThoughtsMissionState,
    thoughtsMissionState,
  };
}
