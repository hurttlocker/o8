'use client';

import type { OrchestratorMissionState, OrchestratorPacket } from '@/lib/orchestrator/types';
import type { RepoFocusRepo } from './types';
import { buildStatusSentence, ProgressCells } from './RepoHeaderProgress';
import {
  currentBranch,
  repoSubtitle,
  REPO_FOCUS_FONT,
  REPO_FOCUS_MONO,
} from './utils';

interface RepoHeaderProps {
  repo: RepoFocusRepo;
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

export function RepoHeader({ repo, packets, missionState, onBack }: RepoHeaderProps) {
  return (
    <header
      style={{
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        paddingTop: 10,
        paddingRight: 14,
        paddingBottom: 12,
        paddingLeft: 10,
        background: 'var(--t-panel)',
        fontFamily: REPO_FOCUS_FONT,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, minWidth: 0 }}>
        <button
          type="button"
          onClick={onBack}
          aria-label="Back to repositories"
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
          }}
        >
          <BackChevron />
        </button>
        <div style={{ flex: 1, minWidth: 0, paddingTop: 2 }}>
          <div
            style={{
              fontSize: 15,
              fontWeight: 600,
              letterSpacing: '-0.02em',
              color: 'var(--t-text)',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {repo.name}
          </div>
          <div
            style={{
              marginTop: 3,
              fontSize: 11.5,
              lineHeight: 1.3,
              color: 'var(--t-text-faint)',
              letterSpacing: '-0.01em',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {repoSubtitle(repo)}
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingLeft: 44 }}>
        <span
          title={currentBranch(repo)}
          style={{
            maxWidth: 128,
            minHeight: 24,
            display: 'inline-flex',
            alignItems: 'center',
            borderRadius: 10,
            background: 'var(--t-input-bg)',
            borderWidth: 1,
            borderStyle: 'solid',
            borderColor: 'var(--t-divider-subtle)',
            color: 'var(--t-text-secondary)',
            paddingTop: 0,
            paddingRight: 8,
            paddingBottom: 0,
            paddingLeft: 8,
            fontFamily: REPO_FOCUS_MONO,
            fontSize: 10.5,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {currentBranch(repo)}
        </span>
        <ProgressCells packets={packets} />
      </div>

      <div
        style={{
          paddingLeft: 44,
          color: packets.length > 0 ? 'var(--t-text-muted)' : 'var(--t-text-faint)',
          fontSize: 11.5,
          lineHeight: 1.35,
          letterSpacing: '-0.01em',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {buildStatusSentence(packets, missionState)}
      </div>
    </header>
  );
}
