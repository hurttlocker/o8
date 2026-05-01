'use client';

import type { OrchestratorMissionState, OrchestratorPacket } from '@/lib/orchestrator/types';
import { missionLabel, packetStatusLabel, packetVisualState, REPO_FOCUS_FONT } from '../utils';

interface MissionTabProps {
  packets: OrchestratorPacket[];
  missionState?: OrchestratorMissionState;
  onSelectSession?: (sessionKey: string) => void;
}

function CheckIcon({ packet }: { packet: OrchestratorPacket }) {
  const state = packetVisualState(packet);
  if (state === 'merged') {
    return (
      <span style={{ width: 18, height: 18, borderRadius: '50%', background: '#16a34a', color: 'var(--t-bg-card)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="m5 13 4 4L19 7" />
        </svg>
      </span>
    );
  }
  if (state === 'failed') {
    return (
      <span style={{ width: 18, height: 18, borderRadius: '50%', background: '#ef4444', color: 'var(--t-bg-card)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" aria-hidden>
          <path d="M6 6l12 12" />
          <path d="M18 6 6 18" />
        </svg>
      </span>
    );
  }
  if (state === 'running' || state === 'awaiting_review') {
    return (
      <span
        style={{
          width: 18,
          height: 18,
          borderRadius: '50%',
          borderWidth: 1,
          borderStyle: 'solid',
          borderColor: 'var(--t-accent)',
          background: 'linear-gradient(90deg, var(--t-accent) 0 50%, transparent 50% 100%)',
          flexShrink: 0,
        }}
      />
    );
  }
  return (
    <span
      style={{
        width: 18,
        height: 18,
        borderRadius: '50%',
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: 'var(--t-divider)',
        background: 'transparent',
        flexShrink: 0,
      }}
    />
  );
}

export function MissionTab({ packets, missionState, onSelectSession }: MissionTabProps) {
  const summary = missionState?.summary?.trim() || missionState?.prompt?.trim() || 'No mission summary available.';

  if (packets.length === 0) {
    return (
      <div style={{ paddingTop: 22, paddingRight: 18, paddingBottom: 22, paddingLeft: 18, color: 'var(--t-text-faint)', fontFamily: REPO_FOCUS_FONT, fontSize: 12.5 }}>
        No active mission for this repo.
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, paddingTop: 14, paddingRight: 14, paddingBottom: 18, paddingLeft: 14, fontFamily: REPO_FOCUS_FONT }}>
      <section
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
          borderRadius: 14,
          borderWidth: 1,
          borderStyle: 'solid',
          borderColor: 'var(--t-divider-subtle)',
          background: 'var(--t-bg-card)',
          paddingTop: 12,
          paddingRight: 12,
          paddingBottom: 12,
          paddingLeft: 12,
        }}
      >
        <div style={{ color: 'var(--t-text)', fontSize: 14, fontWeight: 600, letterSpacing: '-0.02em' }}>
          {missionLabel(missionState)}
        </div>
        <div style={{ color: 'var(--t-text-muted)', fontSize: 12, lineHeight: 1.45, letterSpacing: '-0.01em' }}>
          {summary}
        </div>
      </section>

      <div style={{ display: 'flex', flexDirection: 'column', borderTopWidth: 1, borderTopStyle: 'solid', borderTopColor: 'var(--t-divider-subtle)' }}>
        {packets.map((packet) => {
          const sessionKey = packet.lane?.sessionKey ?? null;
          return (
            <button
              key={packet.id}
              type="button"
              onClick={() => {
                if (sessionKey) onSelectSession?.(sessionKey);
              }}
              style={{
                width: '100%',
                minHeight: 56,
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                borderWidth: 0,
                borderBottomWidth: 1,
                borderBottomStyle: 'solid',
                borderBottomColor: 'var(--t-divider-subtle)',
                background: 'transparent',
                color: 'var(--t-text)',
                cursor: sessionKey ? 'pointer' : 'default',
                textAlign: 'left',
                fontFamily: REPO_FOCUS_FONT,
                paddingTop: 8,
                paddingRight: 0,
                paddingBottom: 8,
                paddingLeft: 0,
              }}
            >
              <CheckIcon packet={packet} />
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: 'block', fontSize: 12.5, fontWeight: 560, letterSpacing: '-0.01em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {packet.referenceLabel ? `${packet.referenceLabel}: ${packet.title}` : packet.title}
                </span>
                <span style={{ display: 'block', marginTop: 3, color: 'var(--t-text-faint)', fontSize: 10.5 }}>
                  {packetStatusLabel(packet)}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
