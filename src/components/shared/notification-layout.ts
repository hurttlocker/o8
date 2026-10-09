'use client';

import { useLayoutEffect, useRef, useSyncExternalStore } from 'react';

let urgentHeight = 0;
const listeners = new Set<() => void>();
const snapshot = () => urgentHeight;

/** Urgent actions sit first; ordinary notices flow below without overlapping. */
export function useUrgentNotificationHeight() {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => listeners.delete(listener); }, snapshot, () => 0);
}

export function useUrgentNotificationRegion(count: number) {
  const ref = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const publish = (height: number) => {
      if (height === urgentHeight) return;
      urgentHeight = height;
      for (const listener of listeners) listener();
    };
    const measure = () => publish(ref.current?.getBoundingClientRect().height ?? 0);
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    if (ref.current) observer?.observe(ref.current);
    return () => { observer?.disconnect(); publish(0); };
  }, [count]);
  return ref;
}
