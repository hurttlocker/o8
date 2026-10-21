'use client';

import { useCallback, useSyncExternalStore } from 'react';

const SHELF_EVENT = 'o8:chat-shelf-changed';
const transientShelves = new Map<string, boolean>();
function subscribeShelf(listener: () => void) {
  window.addEventListener(SHELF_EVENT, listener);
  window.addEventListener('storage', listener);
  return () => { window.removeEventListener(SHELF_EVENT, listener); window.removeEventListener('storage', listener); };
}

export function useCollapsedShelf(key: string, initial = false) {
  const snapshot = useCallback(() => {
    try { const stored = localStorage.getItem(key); return stored === null ? initial : stored === 'true'; }
    catch { return transientShelves.get(key) ?? initial; }
  }, [key, initial]);
  const collapsed = useSyncExternalStore(subscribeShelf, snapshot, () => initial);
  const toggle = () => {
    transientShelves.set(key, !collapsed);
    try { localStorage.setItem(key, String(!collapsed)); } catch { /* Keep the drawer usable. */ }
    window.dispatchEvent(new Event(SHELF_EVENT));
  };
  return [collapsed, toggle] as const;
}
