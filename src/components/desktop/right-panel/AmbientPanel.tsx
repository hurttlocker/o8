'use client';

import { useMemo } from 'react';
import { useOrchestratorData } from '@/components/desktop/orchestrator-data-context';
import type { FleetAgent } from '@/components/desktop/thoughts/types';
import type { OrchestratorMissionState } from '@/lib/orchestrator/types';
import { ModePill } from './ModePill';
import {
  findAmbientRunningPacket,
  useAmbientMode,
  type AmbientLinkedRef,
  type AmbientSelectedFile,
} from './useAmbientMode';
import { DiffMode } from './modes/DiffMode';
import { PulseMode } from './modes/PulseMode';
import { StreamMode } from './modes/StreamMode';
import { StubMode } from './modes/StubMode';

interface AmbientPanelProps {
  missionState: OrchestratorMissionState;
  agents?: FleetAgent[];
  selectedPacketId?: string | null;
  focusedRepoPath?: string | null;
  selectedFile?: AmbientSelectedFile | null;
  selectedIssue?: AmbientLinkedRef | null;
  selectedPR?: AmbientLinkedRef | null;
}

export function AmbientPanel({
  missionState,
  agents,
  selectedPacketId,
  focusedRepoPath,
  selectedFile,
  selectedIssue,
  selectedPR,
}: AmbientPanelProps) {
  const context = useOrchestratorData();
  const resolvedMissionState = context?.missionState ?? missionState;
  const resolvedAgents = context?.agents ?? agents ?? [];
  const modeState = useMemo(() => ({
    missionState: resolvedMissionState,
    focusedRepoPath,
    selectedFile,
    selectedIssue,
    selectedPR,
  }), [focusedRepoPath, resolvedMissionState, selectedFile, selectedIssue, selectedPR]);
  const { mode, locked, toggleLock } = useAmbientMode(modeState);
  const runningPacket = useMemo(() => findAmbientRunningPacket(
    resolvedMissionState.packets,
    focusedRepoPath,
    selectedPacketId,
  ), [focusedRepoPath, resolvedMissionState.packets, selectedPacketId]);

  return (
    <div
      data-chrome-surface="true"
      style={{
        flex: 1,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        background: 'transparent',
        color: 'var(--t-text)',
        fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
      }}
    >
      <div
        style={{
          minHeight: 44,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingTop: 0,
          paddingRight: 8,
          paddingBottom: 0,
          paddingLeft: 8,
          borderBottomWidth: 1,
          borderBottomStyle: 'solid',
          borderBottomColor: 'var(--t-divider-subtle)',
          flexShrink: 0,
        }}
      >
        <ModePill mode={mode} locked={locked} onToggleLock={toggleLock} />
      </div>
      <div
        key={mode}
        style={{
          flex: 1,
          minHeight: 0,
          overflow: 'hidden',
          transition: 'opacity 180ms cubic-bezier(0.22, 1, 0.36, 1)',
        }}
      >
        {mode === 'stream' ? (
          <StreamMode packet={runningPacket} repoPath={runningPacket?.workspaceTargetPath ?? focusedRepoPath ?? null} />
        ) : null}
        {mode === 'diff' ? <DiffMode selectedFile={selectedFile ?? null} /> : null}
        {mode === 'pulse' ? <PulseMode missionState={resolvedMissionState} agents={resolvedAgents} /> : null}
        {mode === 'issue' ? <StubMode mode="issue" linkedRef={selectedIssue ?? null} /> : null}
        {mode === 'pr' ? <StubMode mode="pr" linkedRef={selectedPR ?? null} /> : null}
      </div>
    </div>
  );
}
