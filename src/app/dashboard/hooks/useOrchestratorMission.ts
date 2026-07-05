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
      void persistOrchestratorMissionState(next);
    }, 180);
  }, []);

  const handleThoughtsMissionStateChange = useCallback((
    next: OrchestratorMissionState | ((current: OrchestratorMissionState) => OrchestratorMissionState),
  ) => {
    const updated = updateOrchestratorMissionState(next);
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
