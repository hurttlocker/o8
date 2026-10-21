'use client';

import { useEffect, useState } from 'react';

/** Refresh stale-tool hints only while the orchestrator composer is visible. */
export function useComposerClock(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const refresh = () => setNow(Date.now());
    const initial = setTimeout(refresh, 0);
    const interval = setInterval(refresh, 30_000);
    return () => { clearTimeout(initial); clearInterval(interval); };
  }, [active]);
  return now;
}
