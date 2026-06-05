'use client';

import { useEffect } from 'react';

/**
 * Posts a presence heartbeat every 60s while the o8 window is focused, so the
 * autonomous dogfood loop's gate (~/o8-dogfood-gate.sh) knows a human is here
 * and stands down. Renders nothing. Pairs with /api/panel/attendance/heartbeat.
 */
export function AttendanceHeartbeat() {
  useEffect(() => {
    const ping = () => {
      if (typeof document !== 'undefined' && document.hasFocus()) {
        fetch('/api/panel/attendance/heartbeat', { method: 'POST' }).catch(() => {});
      }
    };
    ping();
    const id = window.setInterval(ping, 60_000);
    return () => window.clearInterval(id);
  }, []);
  return null;
}
