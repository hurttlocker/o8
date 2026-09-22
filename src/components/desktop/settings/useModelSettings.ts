'use client';

import { useCallback, useEffect, useState } from 'react';
import { fetchOperatorDefaults } from './operator-defaults-client';
import type { OperatorDefaults, OperatorDefaultsResponse } from './dispatch-shared';

export function useModelSettings() {
  // ── Operator defaults (shared store with the Dispatch tab) ──
  const [data, setData] = useState<OperatorDefaultsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyField, setBusyField] = useState<keyof OperatorDefaults | null>(null);

  const loadDefaults = useCallback(async () => {
    try {
      const response = await fetchOperatorDefaults();
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(typeof payload.error === 'string' ? payload.error : 'Failed to load model settings.');
      }
      setData(payload as OperatorDefaultsResponse);
      setNotice(null);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Failed to load model settings.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadDefaults(); }, [loadDefaults]);

  const updateField = useCallback(<K extends keyof OperatorDefaults>(field: K, value: OperatorDefaults[K]) => {
    void (async () => {
      setBusyField(field);
      setNotice(null);
      try {
        const response = await fetchOperatorDefaults({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ [field]: value }),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(typeof payload.error === 'string' ? payload.error : 'Failed to update setting.');
        }
        setData(payload as OperatorDefaultsResponse);
      } catch (error) {
        setNotice(error instanceof Error ? error.message : 'Failed to update setting.');
      } finally {
        setBusyField(null);
      }
    })();
  }, []);

  return { data, loading, notice, busyField, updateField };
}
