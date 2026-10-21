import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import { ownedRuntimeCanAcceptInput } from './owned-runtime-steer';

export function useOwnedSessionReadiness(sessionKey: string | null, owned: boolean, active: boolean, queued: number, setReady: Dispatch<SetStateAction<boolean>>) {
  const target = useRef(sessionKey);
  useEffect(() => { target.current = sessionKey; setReady(!owned); }, [owned, sessionKey, setReady]);
  const refresh = useCallback(async (): Promise<boolean> => {
    if (!owned || !sessionKey) return true;
    let ready = false;
    try {
      const response = await fetch('/api/runtime/inventory?fresh=1', { cache: 'no-store' });
      const payload = response.ok ? await response.json().catch(() => null) as { agents?: unknown[] } | null : null;
      ready = ownedRuntimeCanAcceptInput(Array.isArray(payload?.agents) ? payload.agents : [], sessionKey);
    } catch { /* Readiness is unknown while disconnected. */ }
    if (target.current === sessionKey) setReady(ready);
    return target.current === sessionKey && ready;
  }, [owned, sessionKey, setReady]);
  useEffect(() => {
    if (!active || !owned || !sessionKey) return;
    void refresh();
    if (!queued) return;
    const interval = window.setInterval(() => { void refresh(); }, 2000);
    return () => window.clearInterval(interval);
  }, [active, owned, queued, refresh, sessionKey]);
  return refresh;
}
