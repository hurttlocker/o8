'use client';

/**
 * AlertContext — React context + provider for the alert system.
 *
 * Wraps the detection engine. Runs on existing polling data (AgentSummary[]).
 * Stores alerts in sessionStorage so they survive navigation but not app restart.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { AgentSummary } from '@/lib/fleet/types';
import type { Alert } from './types';
import { SEVERITY_ORDER } from './types';
import { detectAlerts, mergeAlerts } from './engine';

const STORAGE_KEY = 'cortex-ide-alerts';
const IS_SERVER = typeof window === 'undefined';

interface AlertContextValue {
  /** All active alerts (sorted: urgent first, newest first within severity) */
  alerts: Alert[];
  /** Unread count */
  unreadCount: number;
  /** Urgent unread count */
  urgentCount: number;
  /** Has any unread alerts */
  hasUnread: boolean;
  /** Mark a single alert as read */
  markRead: (alertId: string) => void;
  /** Mark all alerts as read */
  markAllRead: () => void;
  /** Dismiss a single alert */
  dismiss: (alertId: string) => void;
  /** Dismiss all alerts */
  dismissAll: () => void;
  /** Feed new agent data to the detection engine */
  updateAgents: (agents: AgentSummary[]) => void;
}

const AlertCtx = createContext<AlertContextValue>({
  alerts: [],
  unreadCount: 0,
  urgentCount: 0,
  hasUnread: false,
  markRead: () => {},
  markAllRead: () => {},
  dismiss: () => {},
  dismissAll: () => {},
  updateAgents: () => {},
});

function loadAlerts(): Alert[] {
  if (IS_SERVER) return [];
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveAlerts(alerts: Alert[]) {
  if (IS_SERVER) return;
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(alerts));
  } catch {
    // sessionStorage full or unavailable — silent fail
  }
}

function sortAlerts(alerts: Alert[]): Alert[] {
  return [...alerts].sort((a, b) => {
    // Undismissed first
    if (a.dismissed !== b.dismissed) return a.dismissed ? 1 : -1;
    // By severity
    const sevDiff = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (sevDiff !== 0) return sevDiff;
    // Newest first
    return b.timestamp - a.timestamp;
  });
}

export function AlertProvider({ children }: { children: ReactNode }) {
  // Start empty to match server render — hydrate from sessionStorage after mount
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const alertsRef = useRef(alerts);
  const mountedRef = useRef(false);

  useEffect(() => {
    alertsRef.current = alerts;
  }, [alerts]);

  // Load from sessionStorage AFTER mount (avoids hydration mismatch)
  useEffect(() => {
    const stored = loadAlerts();
    if (stored.length > 0) {
      const timer = window.setTimeout(() => {
        setAlerts(sortAlerts(stored));
      }, 0);
      mountedRef.current = true;
      return () => window.clearTimeout(timer);
    }
    mountedRef.current = true;
    return undefined;
  }, []);

  // Persist on change (skip first render to avoid overwriting before load)
  useEffect(() => {
    if (mountedRef.current) {
      saveAlerts(alerts);
    }
  }, [alerts]);

  const updateAgents = useCallback((agents: AgentSummary[]) => {
    const detected = detectAlerts(agents);
    const merged = mergeAlerts(alertsRef.current, detected);
    const sorted = sortAlerts(merged);
    // Only update state if alerts actually changed
    const prev = alertsRef.current;
    if (
      sorted.length !== prev.length ||
      sorted.some((a, i) => a.id !== prev[i]?.id || a.dismissed !== prev[i]?.dismissed || a.read !== prev[i]?.read)
    ) {
      setAlerts(sorted);
    }
  }, []);

  const markRead = useCallback((alertId: string) => {
    setAlerts((prev) =>
      prev.map((a) => (a.id === alertId ? { ...a, read: true } : a)),
    );
  }, []);

  const markAllRead = useCallback(() => {
    setAlerts((prev) => prev.map((a) => ({ ...a, read: true })));
  }, []);

  const dismiss = useCallback((alertId: string) => {
    setAlerts((prev) =>
      prev.map((a) => (a.id === alertId ? { ...a, dismissed: true } : a)),
    );
  }, []);

  const dismissAll = useCallback(() => {
    setAlerts((prev) => prev.map((a) => ({ ...a, dismissed: true })));
  }, []);

  const activeAlerts = useMemo(
    () => alerts.filter((a) => !a.dismissed),
    [alerts],
  );

  const unreadCount = useMemo(
    () => activeAlerts.filter((a) => !a.read).length,
    [activeAlerts],
  );

  const urgentCount = useMemo(
    () => activeAlerts.filter((a) => !a.read && a.severity === 'urgent').length,
    [activeAlerts],
  );

  const value = useMemo<AlertContextValue>(
    () => ({
      alerts: activeAlerts,
      unreadCount,
      urgentCount,
      hasUnread: unreadCount > 0,
      markRead,
      markAllRead,
      dismiss,
      dismissAll,
      updateAgents,
    }),
    [activeAlerts, unreadCount, urgentCount, markRead, markAllRead, dismiss, dismissAll, updateAgents],
  );

  return <AlertCtx.Provider value={value}>{children}</AlertCtx.Provider>;
}

export function useAlerts() {
  return useContext(AlertCtx);
}
