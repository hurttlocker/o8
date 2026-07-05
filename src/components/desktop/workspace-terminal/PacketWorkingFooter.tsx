'use client';

import { memo, useEffect, useMemo, useState } from 'react';
import { AgentStatusDot } from '@/components/desktop/AgentStatusDot';
import type { PacketTranscriptActivity } from '@/components/desktop/workspace-terminal/use-packet-transcript-poll';
import type { OrchestratorPacketStatus } from '@/lib/orchestrator/types';

interface PacketWorkingFooterProps {
  status: OrchestratorPacketStatus | null;
  runtimeLabel: string;
  activity: PacketTranscriptActivity | null;
  fallbackStartedAt?: string | number | null;
}

function isWorkingStatus(status: OrchestratorPacketStatus | null): boolean {
  return status === 'running' || status === 'launching' || status === 'recovering';
}

function toMs(value: string | number | null | undefined): number | null {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes <= 0) return `${seconds}s`;
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
}

function PacketWorkingFooterBase({
  status,
  runtimeLabel,
  activity,
  fallbackStartedAt,
}: PacketWorkingFooterProps) {
  const working = isWorkingStatus(status);
  const startedAtMs = useMemo(
    () => toMs(activity?.startedAt ?? fallbackStartedAt),
    [activity?.startedAt, fallbackStartedAt],
  );
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!working) return undefined;
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [working, startedAtMs]);

  if (!working) return null;

  const label = activity?.label ?? 'Working';
  const elapsed = startedAtMs == null ? null : formatElapsed(now - startedAtMs);
  const text = activity
    ? `${label} ${elapsed ?? ''}`.trim()
    : `${label}${elapsed ? ` — ${elapsed}` : ''}`;

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 7,
        paddingTop: 12,
        paddingRight: 16,
        paddingBottom: 12,
        paddingLeft: 16,
      }}
    >
      <AgentStatusDot state="running" startedAt={startedAtMs} label={`${runtimeLabel} working`} />
      <span
        style={{
          fontSize: 11,
          color: 'var(--t-text-faint)',
          fontFamily: 'var(--font-sans-system)',
          fontWeight: 500,
        }}
      >
        {text}
      </span>
    </div>
  );
}

export const PacketWorkingFooter = memo(PacketWorkingFooterBase);
