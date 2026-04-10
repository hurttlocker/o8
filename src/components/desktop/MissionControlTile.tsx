'use client';

import { memo, useEffect, useRef, useState } from 'react';
import {
  readOrchestratorRuntimePreference,
  subscribeOrchestratorRuntimePreference,
} from '@/lib/orchestrator/preferences';
import type { OrchestratorRuntime } from '@/lib/orchestrator/types';
import {
  ThoughtsMissionPanel,
  type ThoughtsMissionPanelHandle,
} from './thoughts/ThoughtsMissionPanel';
import type { FleetAgent, ThoughtsCardProps } from './thoughts/types';
import { buildAgentTargets } from './thoughts/utils';

/**
 * Tile-native wrapper around ThoughtsMissionPanel. The panel's internals
 * (packet planning, dispatch, approvals) are unchanged; this tile gives
 * it a header and close affordance so it can live as a splittable sibling
 * of the orchestrator chat.
 */

interface MissionControlTileProps {
  onClose: () => void;
  agents?: FleetAgent[];
  missionState: ThoughtsCardProps['missionState'];
  workspaceTargets?: ThoughtsCardProps['workspaceTargets'];
  onMissionStateChange: ThoughtsCardProps['onMissionStateChange'];
  onLaunchPacket?: ThoughtsCardProps['onLaunchPacket'];
  onFocusPacket?: ThoughtsCardProps['onFocusPacket'];
  repoLabel?: string | null;
}

function MissionControlTileBase({
  onClose,
  agents = [],
  missionState,
  workspaceTargets = [],
  onMissionStateChange,
  onLaunchPacket,
  onFocusPacket,
  repoLabel,
}: MissionControlTileProps) {
  const [preferredRuntime, setPreferredRuntime] = useState<OrchestratorRuntime>(
    () => readOrchestratorRuntimePreference(),
  );
  const panelRef = useRef<ThoughtsMissionPanelHandle>(null);

  useEffect(() => subscribeOrchestratorRuntimePreference(setPreferredRuntime), []);

  useEffect(() => {
    const timeout = window.setTimeout(() => panelRef.current?.focusInput(), 60);
    return () => window.clearTimeout(timeout);
  }, []);

  const sessionTargets = buildAgentTargets(agents, preferredRuntime);

  const thoughtsBodyBackground = 'linear-gradient(180deg, var(--t-glass-muted) 0%, rgba(0, 0, 0, 0) 100%)';
  const thoughtsElevatedSurface = 'var(--t-glass-elevated)';
  const thoughtsElevatedBorder = '1px solid var(--t-glass-border-strong)';
  const thoughtsElevatedShadow = 'var(--t-glass-shadow)';
  const thoughtsMutedGlass = 'var(--t-glass-muted-strong)';

  const title = repoLabel ? `Mission Control · ${repoLabel}` : 'Mission Control';

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        background: 'var(--t-bg)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          paddingTop: 10,
          paddingRight: 12,
          paddingBottom: 10,
          paddingLeft: 14,
          borderBottomWidth: 1,
          borderBottomStyle: 'solid',
          borderBottomColor: 'var(--t-divider-subtle)',
          background: 'var(--t-panel)',
          minHeight: 44,
        }}
      >
        <div
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: 12,
            fontWeight: 700,
            color: 'var(--t-text)',
            letterSpacing: '-0.01em',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
          title={title}
        >
          {title}
        </div>
        <button
          type="button"
          onClick={onClose}
          title="Close"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 28,
            height: 28,
            borderRadius: 8,
            borderWidth: 0,
            background: 'transparent',
            color: 'var(--t-text-muted)',
            cursor: 'pointer',
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <ThoughtsMissionPanel
          ref={panelRef}
          open
          visible
          missionState={missionState}
          workspaceTargets={workspaceTargets}
          preferredRuntime={preferredRuntime}
          sessionTargets={sessionTargets}
          thoughtsBodyBackground={thoughtsBodyBackground}
          thoughtsElevatedSurface={thoughtsElevatedSurface}
          thoughtsElevatedBorder={thoughtsElevatedBorder}
          thoughtsElevatedShadow={thoughtsElevatedShadow}
          thoughtsMutedGlass={thoughtsMutedGlass}
          onMissionStateChange={onMissionStateChange}
          onLaunchPacket={onLaunchPacket}
          onFocusPacket={onFocusPacket}
        />
      </div>
    </div>
  );
}

export const MissionControlTile = memo(MissionControlTileBase);
