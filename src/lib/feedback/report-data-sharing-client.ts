'use client';

import { useCallback, useEffect, useState } from 'react';

import { REPORT_DATA_SHARING_OFF_MESSAGE } from '@/lib/feedback/data-sharing';

type SharingStatus = 'checking' | 'enabled' | 'disabled';

interface TelemetryConfigResponse {
  enabled?: unknown;
}

interface OperatorDefaultsResponse {
  values?: {
    crashReportsEnabled?: unknown;
  };
  error?: unknown;
}

export async function readReportDataSharingEnabled(): Promise<boolean> {
  const response = await fetch('/api/telemetry/config', { cache: 'no-store' });
  const body = await response.json().catch(() => null) as TelemetryConfigResponse | null;
  if (!response.ok || typeof body?.enabled !== 'boolean') {
    throw new Error('Could not confirm the crash & error reports setting.');
  }
  return body.enabled;
}

async function persistReportDataSharingEnabled(): Promise<void> {
  const response = await fetch('/api/panel/operator-defaults', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ crashReportsEnabled: true }),
  });
  const body = await response.json().catch(() => null) as OperatorDefaultsResponse | null;
  if (!response.ok) {
    throw new Error(typeof body?.error === 'string' ? body.error : 'Could not enable data sharing.');
  }
  if (body?.values?.crashReportsEnabled !== true) {
    throw new Error('Crash & error reports are locked off by an environment setting.');
  }
}

export function useReportDataSharing() {
  const [status, setStatus] = useState<SharingStatus>('checking');
  const [error, setError] = useState<string | null>(null);
  const [enabling, setEnabling] = useState(false);

  const check = useCallback(async (showChecking = true) => {
    if (showChecking) setStatus('checking');
    setError(null);
    try {
      const enabled = await readReportDataSharingEnabled();
      setStatus(enabled ? 'enabled' : 'disabled');
      return enabled;
    } catch (checkError) {
      setStatus('disabled');
      setError(checkError instanceof Error ? checkError.message : 'Could not confirm data sharing.');
      return false;
    }
  }, []);

  const enable = useCallback(async () => {
    setEnabling(true);
    setError(null);
    try {
      await persistReportDataSharingEnabled();
      setStatus('enabled');
      return true;
    } catch (enableError) {
      setStatus('disabled');
      setError(enableError instanceof Error ? enableError.message : 'Could not enable data sharing.');
      return false;
    } finally {
      setEnabling(false);
    }
  }, []);

  const markDisabled = useCallback((reason = REPORT_DATA_SHARING_OFF_MESSAGE) => {
    setStatus('disabled');
    setError(reason === REPORT_DATA_SHARING_OFF_MESSAGE ? null : reason);
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

  return {
    status,
    error,
    enabling,
    enabled: status === 'enabled',
    check,
    enable,
    markDisabled,
  };
}
