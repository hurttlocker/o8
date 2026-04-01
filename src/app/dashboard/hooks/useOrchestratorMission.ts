import { useCallback, useEffect, useRef, useState } from 'react';
import type { OrchestratorMissionState } from '@/lib/orchestrator/types';
import {
  loadOrchestratorMissionState,
  persistOrchestratorMissionState,
  readOrchestratorMissionState,
  subscribeOrchestratorMissionState,
  updateOrchestratorMissionState,
} from '@/lib/orchestrator/store';

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
