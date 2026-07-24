'use client';

import { memo, type CSSProperties } from 'react';
import type { MobileInboxSnapshot } from '@/lib/mobile/types';
import { GroupedSessionList } from './RecentSessionPicker';
import { useTheme } from './ThemeContext';
import { isDispatchableRuntime } from '@/lib/orchestrator/runtime-capabilities';

interface FleetViewProps {
  sessions: MobileInboxSnapshot['sessions'];
  onAgentSelect: (sessionKey: string) => void;
  onBack: () => void;
  onLaunch: () => void;
  hideHeader?: boolean;
}

function renderFleetSessionName(session: MobileInboxSnapshot['sessions'][number]) {
  return session.name?.trim() || session.surfaceLabel?.trim() || 'Untitled session';
}

function PlusIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  );
}

export const FleetView = memo(function FleetView({
  sessions,
  onAgentSelect,
  onBack,
  onLaunch,
  hideHeader = false,
}: FleetViewProps) {
  const { colors } = useTheme();
  // The mobile inbox snapshot includes workspace LLM chat tabs (runtime: 'chat')
  // alongside spawned agents — those are orchestrator + assistant chats and
  // shouldn't appear in the Agents fleet view. Filter to spawned-agent
  // runtimes only.
  const spawnedAgents = sessions.filter((session) => isDispatchableRuntime(session.runtime));

  const iconButtonStyle: CSSProperties = {
    width: 36,
    height: 36,
    minWidth: 36,
    minHeight: 36,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 999,
    border: `1px solid ${colors.border}`,
    background: colors.cardBg,
    color: colors.text,
    cursor: 'pointer',
    WebkitTapHighlightColor: 'transparent',
  };

  return (
    <section
      style={{
        width: '100%',
        minHeight: '100%',
        background: colors.bg,
      }}
    >
      {hideHeader ? null : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'auto 1fr auto',
            alignItems: 'center',
            gap: 12,
            padding: '8px 16px 4px',
          }}
        >
          <button
            type="button"
            onClick={onBack}
            style={{
              minHeight: 44,
              padding: 0,
              border: 'none',
              background: 'transparent',
              color: colors.blueAccent,
              fontSize: 16,
              fontWeight: 500,
              cursor: 'pointer',
              WebkitTapHighlightColor: 'transparent',
            }}
          >
            Done
          </button>

          <h2
            style={{
              margin: 0,
              textAlign: 'center',
              color: colors.text,
              fontSize: 17,
              fontWeight: 600,
              letterSpacing: '-0.02em',
            }}
          >
            Sessions
          </h2>

          <button
            type="button"
            onClick={onLaunch}
            aria-label="Launch new remote session"
            style={iconButtonStyle}
          >
            <PlusIcon />
          </button>
        </div>
      )}

      <GroupedSessionList
        sessions={spawnedAgents}
        onSessionSelect={onAgentSelect}
        renderSessionName={renderFleetSessionName}
        emptyMessage="No spawned agents yet. Dispatch a packet from the Orchestrator."
        topPadding={hideHeader ? 8 : 2}
      />
    </section>
  );
});
