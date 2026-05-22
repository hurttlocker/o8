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
  imageInjection?: ThoughtsCardProps['imageInjection'];
  onImageInjectionConsumed?: ThoughtsCardProps['onImageInjectionConsumed'];
  /** Open the given agent session in a workspace terminal tab. */
  onSelectSession?: (sessionKey: string) => void;
  /** Tab id of the most-recently dispatched packet, for soft-orange highlight. */
  latestDispatchedTabId?: string | null;
  /** Epoch ms timestamp of the most-recent dispatch — surfaced in tab tooltips. */
  latestDispatchedAt?: number | null;
  /**
   * #746 — Auto-directive proposer hook. The DirectiveProposalRow injects
   * the candidate's draft text into the orchestrator chat composer when the
   * operator clicks Accept. Drilling this through `draftInjection` directly
   * would conflict with quick-action palette drafts; a dedicated hook keeps
   * the two surfaces independent.
   */
  onAcceptDirectiveProposal?: (draft: { id: string; text: string }) => void;
  /**
   * #888/#895 — When the operator expands a packet in the orchestrator's
   * mission rail, the dashboard's right-side workspace panel pivots from
   * `idle` (Changes/Files/Git Log) to `packet` (Spec/Agent Overview).
   * The selection is owned by ThoughtsMissionPanel and surfaced here so
   * the dashboard can react without prop-drilling through every layer.
   */
  selectedPacketId?: string | null;
  onSelectedPacketChange?: (packetId: string | null) => void;
  /**
   * Open the wide O8 panel pinned to a specific repo path + tab. Used by
   * Recent Work click-routing so a NEEDS YOU click lands the operator on
   * the workspace tab AND auto-pops the diff view for that worktree.
   */
  onOpenO8Panel?: (options: { repoPath?: string | null; tab?: 'workspace' | 'prs' | 'inbox' | 'activity' | 'spec' | 'browser' }) => void;
  /**
   * Whether the wide O8 right panel is currently visible. Surfaced so the
   * OrchestratorTab can render a Codex-style Branch details launcher in the
   * empty right gutter when (and only when) the wide panel is collapsed.
   */
  o8PanelVisible?: boolean;
  /**
   * Header-owned project context rail state for the active workspace pane.
   * The rail itself lives inside OrchestratorTab; WorkspaceHeaderStrip owns
   * the show/hide affordance so it can work in both single and split panes.
   */
  projectContextRailVisible?: boolean;
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
