'use client';

import { useCallback, useRef, useState } from 'react';

/** Keeps one body-bound mutation locked until its exact receipt is terminal. */
export function useCorrelatedActionLatch<Action extends string>() {
  const busyRef = useRef<Action | null>(null);
  const [busy, setBusy] = useState<Action | null>(null);

  const begin = useCallback((action: Action) => {
    if (busyRef.current) return false;
    busyRef.current = action;
    setBusy(action);
    return true;
  }, []);

  const settle = useCallback((inProgress: boolean) => {
    if (inProgress) return;
    busyRef.current = null;
    setBusy(null);
  }, []);

  return { busy, begin, settle };
}
