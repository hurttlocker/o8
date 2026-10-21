'use client';

import { useCallback, useMemo, useSyncExternalStore, type SetStateAction } from 'react';
import { isRightUtilityTab, type O8Tab, type RightUtilityTab } from './types';

const changedEvent = 'o8:right-panel:utility-tabs-changed';
const memoryFallback = new Map<string, string>();
const serverSnapshot = () => null;
function readRaw(key: string): string | null {
  if (memoryFallback.has(key)) return memoryFallback.get(key)!;
  try { return window.localStorage.getItem(key); } catch { return null; }
}
function parseTabs(raw: string | null): RightUtilityTab[] {
  try {
    const saved: unknown = JSON.parse(raw ?? '[]');
    if (!Array.isArray(saved)) return [];
    return [...new Set(saved.filter((tab): tab is RightUtilityTab => typeof tab === 'string'
      && isRightUtilityTab(tab as O8Tab) && tab !== 'browser'))];
  } catch { return []; }
}
function subscribe(callback: () => void) {
  window.addEventListener(changedEvent, callback);
  window.addEventListener('storage', callback);
  return () => { window.removeEventListener(changedEvent, callback); window.removeEventListener('storage', callback); };
}

export function usePersistedUtilityTabs(scope: string) {
  const key = `o8:right-panel:utility-tabs:v1:${scope}`;
  const snapshot = useCallback(() => readRaw(key), [key]);
  const raw = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  const tabs = useMemo(() => parseTabs(raw), [raw]);
  const setTabs = useCallback((action: SetStateAction<RightUtilityTab[]>) => {
    const current = parseTabs(readRaw(key));
    const next = JSON.stringify(typeof action === 'function' ? action(current) : action);
    if (next === readRaw(key)) return;
    try { window.localStorage.setItem(key, next); memoryFallback.delete(key); }
    catch { memoryFallback.set(key, next); }
    window.dispatchEvent(new Event(changedEvent));
  }, [key]);
  return [tabs, setTabs] as const;
}
