'use client';

import { useEffect, useSyncExternalStore } from 'react';
import { initializeCompletionStart, ROW_LAST_VISITED_KEY, ROW_READ_EVENT } from './read-state';

function subscribe(listener: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === ROW_LAST_VISITED_KEY) listener();
  };
  window.addEventListener(ROW_READ_EVENT, listener);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(ROW_READ_EVENT, listener);
    window.removeEventListener('storage', onStorage);
  };
}
function snapshot() {
  try { return window.localStorage.getItem(ROW_LAST_VISITED_KEY) ?? '{}'; }
  catch { return '{}'; }
}
/** Subscribe to acknowledgments without treating refreshes as reading. */
export function useRowReadState() {
  useEffect(() => initializeCompletionStart(), []);
  return useSyncExternalStore(subscribe, snapshot, () => '{}');
}
