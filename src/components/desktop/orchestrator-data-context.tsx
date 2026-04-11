'use client';

/**
 * OrchestratorDataContext — exposes the orchestrator's data dependencies
 * (agents fleet, mission state, workspace targets, launch callbacks) from
 * the dashboard page down to anywhere in the tree.
 *
 * Why this exists: the orchestrator now lives as a TAB inside
 * WorkspaceTerminal, not as a top-level tile. The WorkspaceTerminal tree
 * is deep and already carries a lot of props — threading all the
 * orchestrator-specific deps through it would be heavy prop-drilling.
 * A dedicated context lets the orchestrator tab renderer consume what it
 * needs without touching every intermediate component.
 *
 * This is separate from OrchestratorTileBus (which is for cross-tile
 * messaging). This one is read-only data.
 */

import { createContext, useContext, type ReactNode } from 'react';
import type { FleetAgent, ThoughtsCardProps } from './thoughts/types';

export interface OrchestratorDataValue {
  agents: FleetAgent[];
  missionState: ThoughtsCardProps['missionState'];
  workspaceTargets: ThoughtsCardProps['workspaceTargets'];
  onMissionStateChange: ThoughtsCardProps['onMissionStateChange'];
  onLaunchPacket?: ThoughtsCardProps['onLaunchPacket'];
  draftInjection?: ThoughtsCardProps['draftInjection'];
}

const OrchestratorDataContext = createContext<OrchestratorDataValue | null>(null);

interface OrchestratorDataProviderProps extends OrchestratorDataValue {
  children: ReactNode;
}

export function OrchestratorDataProvider({
  children,
  ...value
}: OrchestratorDataProviderProps) {
  return (
    <OrchestratorDataContext.Provider value={value}>
      {children}
    </OrchestratorDataContext.Provider>
  );
}

/**
 * Consumers call this hook from inside the dashboard subtree. Returns
 * null if no provider is mounted (which should never happen in the
 * dashboard but does happen in isolated unit tests).
 */
export function useOrchestratorData(): OrchestratorDataValue | null {
  return useContext(OrchestratorDataContext);
}
