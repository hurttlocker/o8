import { useCallback, useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type { PendingSteer } from './PendingSteerCard';

const STEER_FIRE_LATCH_TIMEOUT_MS = 6000;

interface UseSteerAutoFireOptions {
  displayWaiting: boolean;
  isOrchestratorMode: boolean;
  pendingSteers: PendingSteer[];
  editingSteerId: string | null;
  setPendingSteers: Dispatch<SetStateAction<PendingSteer[]>>;
  sendNowRef: MutableRefObject<(text?: string) => void>;
}

export function useSteerAutoFire({
  displayWaiting,
  isOrchestratorMode,
  pendingSteers,
  editingSteerId,
  setPendingSteers,
  sendNowRef,
}: UseSteerAutoFireOptions): { clearFiringSteerLatch: () => void } {
  const firingSteerRef = useRef(false);
  const firingSteerTimerRef = useRef<number | null>(null);

  const clearFiringSteerLatch = useCallback(() => {
    firingSteerRef.current = false;
    if (firingSteerTimerRef.current !== null) {
      window.clearTimeout(firingSteerTimerRef.current);
      firingSteerTimerRef.current = null;
    }
  }, []);

  const armFiringSteerLatch = useCallback(() => {
    firingSteerRef.current = true;
    if (firingSteerTimerRef.current !== null) {
      window.clearTimeout(firingSteerTimerRef.current);
    }
    firingSteerTimerRef.current = window.setTimeout(() => {
      firingSteerRef.current = false;
      firingSteerTimerRef.current = null;
    }, STEER_FIRE_LATCH_TIMEOUT_MS);
  }, []);

  useEffect(() => () => {
    if (firingSteerTimerRef.current !== null) window.clearTimeout(firingSteerTimerRef.current);
  }, []);

  useEffect(() => {
    if (isOrchestratorMode || !displayWaiting) return;
    clearFiringSteerLatch();
  }, [clearFiringSteerLatch, displayWaiting, isOrchestratorMode]);

  useEffect(() => {
    if (displayWaiting) return;
    if (pendingSteers.length === 0) return;
    if (firingSteerRef.current) return;
    const head = pendingSteers[0];
    if (editingSteerId === head.id) return;
    armFiringSteerLatch();
    setPendingSteers((prev) => prev.slice(1));
    sendNowRef.current(head.text);
  }, [armFiringSteerLatch, displayWaiting, pendingSteers, editingSteerId, setPendingSteers, sendNowRef]);

  return { clearFiringSteerLatch };
}
