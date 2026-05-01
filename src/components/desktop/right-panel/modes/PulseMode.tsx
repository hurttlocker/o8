'use client';

import { useMemo } from 'react';
import type { FleetAgent } from '@/components/desktop/thoughts/types';
import type { OrchestratorMissionState, OrchestratorRuntime } from '@/lib/orchestrator/types';

const MONO = 'var(--font-mono, "SF Mono", Menlo, monospace)';

interface PulseModeProps {
  missionState: OrchestratorMissionState;
  agents: FleetAgent[];
}

function isToday(raw: string | null | undefined): boolean {
  if (!raw) return false;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return false;
  const now = new Date();
  return date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
}

function normalizeRuntime(raw: string | null | undefined): OrchestratorRuntime {
  if (raw === 'claude-code' || raw === 'gemini' || raw === 'opencode') return raw;
  return 'codex';
}

export function PulseMode({ missionState, agents }: PulseModeProps) {
  const stats = useMemo(() => {
    const packets = missionState.packets;
    const dispatched = packets.filter((packet) => packet.status !== 'draft' || Boolean(packet.lane)).length;
    const awaiting = packets.filter((packet) => packet.status === 'awaiting_review').length;
    const mergedToday = packets.filter((packet) => (
      (packet.releaseState === 'released' || packet.status === 'released')
      && isToday(packet.archivedAt ?? packet.review?.recordedAt ?? packet.lastEventAt)
    )).length;
    const liveKeys = new Set<string>();
    const runtimeCounts: Record<OrchestratorRuntime, number> = {
      codex: 0,
      gemini: 0,
      'claude-code': 0,
      opencode: 0,
    };
    for (const agent of agents) {
      if (agent.status !== 'running') continue;
      const key = agent.sessionKey ?? `${agent.runtime ?? 'codex'}:${agent.name ?? liveKeys.size}`;
      if (liveKeys.has(key)) continue;
      liveKeys.add(key);
      runtimeCounts[normalizeRuntime(agent.runtime)] += 1;
    }
    for (const packet of packets) {
      if (packet.status !== 'running') continue;
      const key = packet.lane?.sessionKey ?? packet.id;
      if (liveKeys.has(key)) continue;
      liveKeys.add(key);
      runtimeCounts[normalizeRuntime(packet.runtime)] += 1;
    }
    return {
      dispatched,
      awaiting,
      mergedToday,
      liveTotal: liveKeys.size,
      runtimeText: `CX ${runtimeCounts.codex} / GM ${runtimeCounts.gemini} / CC ${runtimeCounts['claude-code']} / OC ${runtimeCounts.opencode}`,
    };
  }, [agents, missionState.packets]);

  if (stats.dispatched === 0 && stats.liveTotal === 0) {
    return <EmptyPulse />;
  }

  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        paddingTop: 10,
        paddingRight: 10,
        paddingBottom: 10,
        paddingLeft: 10,
        overflowY: 'auto',
      }}
    >
      <StatBlock label={`[DISPATCHED ${stats.dispatched}]`} description="packets launched from this mission" />
      <StatBlock label={`[REVIEW ${stats.awaiting}]`} description="awaiting operator review" />
      <StatBlock label={`[MERGED ${stats.mergedToday}]`} description="released since local midnight" />
      <StatBlock label={`[MIX ${stats.runtimeText}]`} description="live runtime mix" />
    </div>
  );
}

function EmptyPulse() {
  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        paddingTop: 24,
        paddingRight: 16,
        paddingBottom: 24,
        paddingLeft: 16,
        color: 'var(--t-text-muted)',
        fontSize: 12,
        letterSpacing: '-0.01em',
      }}
    >
      [PULSE] · no fleet activity
    </div>
  );
}

function StatBlock({ label, description }: { label: string; description: string }) {
  return (
    <div
      style={{
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: 'var(--t-divider-subtle)',
        borderRadius: 8,
        background: 'var(--t-bg-card)',
        paddingTop: 11,
        paddingRight: 12,
        paddingBottom: 12,
        paddingLeft: 12,
      }}
    >
      <div
        style={{
          fontFamily: MONO,
          fontSize: 11,
          fontWeight: 500,
          letterSpacing: '0.04em',
          color: 'var(--t-text-muted)',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {label}
      </div>
      <div
        style={{
          marginTop: 5,
          color: 'var(--t-text)',
          fontSize: 12,
          fontWeight: 400,
          letterSpacing: '-0.01em',
          lineHeight: 1.45,
        }}
      >
        {description}
      </div>
    </div>
  );
}
