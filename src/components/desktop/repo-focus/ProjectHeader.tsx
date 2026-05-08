'use client';

import type { ProjectRecord } from '../repo-registry/useProjects';
import type { OrchestratorMissionState, OrchestratorPacket } from '@/lib/orchestrator/types';
import { REPO_FOCUS_FONT } from './utils';

interface ProjectHeaderProps {
  project: ProjectRecord;
  repoCount: number;
  packets: OrchestratorPacket[];
  missionState?: OrchestratorMissionState;
  onBack: () => void;
}

function BackChevron() {
  return (
    <svg
      width={18}
      height={18}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ display: 'block', flexShrink: 0 }}
      aria-hidden
    >
      <path d="m15 18-6-6 6-6" />
    </svg>
  );
}

function rollUpPackets(packets: OrchestratorPacket[]): { running: number; awaitingReview: number } {
  let running = 0;
  let awaitingReview = 0;
  for (const packet of packets) {
    if (packet.status === 'running' || packet.status === 'launching' || packet.status === 'recovering') running += 1;
    else if (packet.status === 'awaiting_review') awaitingReview += 1;
  }
  return { running, awaitingReview };
}

export function ProjectHeader({ project, repoCount, packets, missionState, onBack }: ProjectHeaderProps) {
  const { running, awaitingReview } = rollUpPackets(packets);
  const repoSentence = `${repoCount} repo${repoCount === 1 ? '' : 's'}`;
  const packetSentence = running > 0 || awaitingReview > 0
    ? `${running} running · ${awaitingReview} awaiting review`
    : missionState?.summary?.split('\n')[0]?.trim() || 'No active work';

  return (
    <header
      style={{
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        paddingTop: 10,
        paddingRight: 14,
        paddingBottom: 10,
        paddingLeft: 10,
        background: 'transparent',
        fontFamily: REPO_FOCUS_FONT,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, minWidth: 0 }}>
        <button
          type="button"
          onClick={onBack}
          aria-label="Back to repositories"
          title="Back to repositories — esc"
          style={{
            width: 44,
            height: 44,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderWidth: 0,
            borderRadius: 12,
            background: 'transparent',
            color: 'var(--t-text-muted)',
            cursor: 'pointer',
            flexShrink: 0,
            transition: 'background 140ms cubic-bezier(0.22, 1, 0.36, 1), color 140ms cubic-bezier(0.22, 1, 0.36, 1), transform 80ms ease-out',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--t-hover)'; e.currentTarget.style.color = 'var(--t-text)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--t-text-muted)'; }}
          onMouseDown={(e) => { e.currentTarget.style.transform = 'scale(0.94)'; }}
          onMouseUp={(e) => { e.currentTarget.style.transform = 'scale(1)'; }}
        >
          <BackChevron />
        </button>
        <div style={{ flex: 1, minWidth: 0, paddingTop: 4 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
              color: 'var(--t-text-faint)',
            }}
          >
            {project.color ? (
              <span
                aria-hidden
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  background: project.color,
                  flexShrink: 0,
                }}
              />
            ) : null}
            <span>Project</span>
          </div>
          <div
            style={{
              marginTop: 2,
              fontSize: 17,
              fontWeight: 600,
              letterSpacing: '-0.02em',
              color: 'var(--t-text)',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {project.name}
          </div>
          <div
            style={{
              marginTop: 4,
              fontSize: 11.5,
              lineHeight: 1.35,
              color: 'var(--t-text-muted)',
              letterSpacing: '-0.005em',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {repoSentence} · {packetSentence}
          </div>
        </div>
      </div>
    </header>
  );
}
