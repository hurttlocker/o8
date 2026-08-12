'use client';

import { useCallback, useState } from 'react';
import {
  correlatedActionIsUnsettled,
  fetchCorrelatedActionReceipt,
} from '@/lib/orchestrator/action-receipt';

export function O8ActivityMissionControls({
  missionId,
}: {
  missionId: string;
}) {
  const [haltBusy, setHaltBusy] = useState(false);

  const handleStopMission = useCallback(async () => {
    if (!missionId) return;
    setHaltBusy(true);
    let receiptUnsettled = false;
    try {
      const requestBody = JSON.stringify({
        missionId,
        idempotencyKey: crypto.randomUUID(),
      });
      const { response, payload } = await fetchCorrelatedActionReceipt<{
        ok?: boolean;
        result?: { inProgress?: boolean; status?: string };
        error?: { message?: string };
      }>('/api/orchestrator/stop-mission', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: requestBody,
      });
      if (!response.ok || !payload?.ok) {
        throw new Error(payload?.error?.message ?? 'Mission stop failed.');
      }
      window.dispatchEvent(new Event('o8:lane-lifecycle'));
    } catch (error) {
      receiptUnsettled = correlatedActionIsUnsettled(error);
      console.error('[o8-activity] stop mission failed:', error);
    } finally {
      if (!receiptUnsettled) setHaltBusy(false);
    }
  }, [missionId]);

  const buttonStyle = {
    height: 24,
    paddingTop: 0,
    paddingRight: 8,
    paddingBottom: 0,
    paddingLeft: 8,
    borderRadius: 8,
    border: '0.5px solid var(--t-divider-subtle)',
    fontSize: 10,
    fontWeight: 500,
    cursor: haltBusy ? 'default' : 'pointer',
    opacity: haltBusy ? 0.55 : 1,
  } as const;

  if (!missionId) return null;
  return (
    <button
        type="button"
        onClick={handleStopMission}
        disabled={haltBusy}
        title="Stop and hold every packet in this mission"
        style={{
          ...buttonStyle,
          flexShrink: 0,
          background: 'transparent',
          color: 'var(--t-text-muted)',
        }}
      >
        Stop mission
      </button>
  );
}
