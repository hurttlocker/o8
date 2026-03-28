'use client';

import { useEffect, useState } from 'react';
import {
  readOpenClawBetaStatus,
  refreshOpenClawBetaStatus,
  subscribeOpenClawBetaStatus,
  type OpenClawIntegrationStatus,
} from '@/lib/connectors/openclaw-beta';

const OPENCLAW_STATUS_POLL_MS = 15000;

export function useOpenClawBetaStatus() {
  const [status, setStatus] = useState<OpenClawIntegrationStatus>(() => readOpenClawBetaStatus());

  useEffect(() => {
    let active = true;

    const refresh = async (force = false) => {
      const next = await refreshOpenClawBetaStatus();
      if (!active) return;
      setStatus((current) => {
        if (
          !force
          && current.mode === next.mode
          && current.effective_enabled === next.effective_enabled
          && current.configured === next.configured
          && current.error === next.error
        ) {
          return current;
        }
        return next;
      });
    };

    void refresh(true);
    const unsubscribe = subscribeOpenClawBetaStatus(setStatus);
    const intervalId = window.setInterval(() => {
      void refresh();
    }, OPENCLAW_STATUS_POLL_MS);

    return () => {
      active = false;
      unsubscribe();
      window.clearInterval(intervalId);
    };
  }, []);

  return {
    status,
    enabled: status.effective_enabled,
  };
}
