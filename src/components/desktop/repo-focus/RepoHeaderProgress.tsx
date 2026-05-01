'use client';

import type { OrchestratorMissionState, OrchestratorPacket } from '@/lib/orchestrator/types';
import { missionLabel, packetVisualState } from './utils';

export function ProgressCells({ packets }: { packets: OrchestratorPacket[] }) {
  if (packets.length === 0) {
    return (
      <div
        aria-hidden
        style={{
          width: '100%',
          height: 4,
          borderRadius: 999,
          background: 'var(--t-divider-subtle)',
          marginTop: 2,
        }}
      />
    );
  }

  return (
    <div aria-hidden style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
      {Array.from({ length: 8 }).map((_, index) => {
        const packet = packets[index] ?? null;
        const state = packet ? packetVisualState(packet) : 'queued';
        const active = state === 'running' || state === 'awaiting_review';
        const fill =
          state === 'merged'
            ? 'var(--t-brand-orange, #FF5A1F)'
            : state === 'failed'
              ? '#ef4444'
              : active
                ? 'var(--t-brand-orange, #FF5A1F)'
                : 'var(--t-divider-subtle)';
        return (
          <span
            key={index}
            style={{
              width: 12,
              height: 6,
              borderRadius: 2,
              overflow: 'hidden',
              background: active ? 'var(--t-divider-subtle)' : fill,
              flexShrink: 0,
            }}
          >
            {active ? (
              <span style={{ display: 'block', width: '50%', height: '100%', background: fill }} />
            ) : null}
          </span>
        );
      })}
    </div>
  );
}

export function buildStatusSentence(
  packets: OrchestratorPacket[],
  missionState?: OrchestratorMissionState,
): string {
  if (packets.length === 0) return 'No active mission';
  const running = packets.filter((packet) => packetVisualState(packet) === 'running').length;
  const awaiting = packets.filter((packet) => packet.status === 'awaiting_review').length;
  return `Mission ${missionLabel(missionState)} · ${running} running, ${awaiting} awaiting review`;
}
