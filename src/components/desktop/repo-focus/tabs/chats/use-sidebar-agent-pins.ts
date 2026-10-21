'use client';

import { useCallback, useEffect, useState } from 'react';
import type { ExtraAgentRow } from '../../../AgentPanelExtraAgentRow';
import { isSidebarAgentPinned, sidebarAgentPinKeys } from './sidebar-agent-navigation';

export const SIDEBAR_AGENT_PINS_KEY = 'o8:sidebar-agent-pins:v1';

function readPins(): Set<string> {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(SIDEBAR_AGENT_PINS_KEY) ?? '[]');
    return new Set(Array.isArray(value) ? value.filter((key): key is string => typeof key === 'string').slice(0, 2000) : []);
  } catch { return new Set(); }
}

export function useSidebarAgentPins() {
  const [keys, setKeys] = useState(readPins);
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === SIDEBAR_AGENT_PINS_KEY) setKeys(readPins());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);
  const toggle = useCallback((row: Pick<ExtraAgentRow, 'key' | 'sessionKey'>) => {
    const next = new Set(keys);
    const pinned = isSidebarAgentPinned(keys, row);
    for (const key of sidebarAgentPinKeys(row)) {
      if (pinned) next.delete(key); else next.add(key);
    }
    try { window.localStorage.setItem(SIDEBAR_AGENT_PINS_KEY, JSON.stringify([...next])); }
    catch { return false; }
    setKeys(next);
    return true;
  }, [keys]);
  return { keys, toggle };
}
