import { laneStatusToStateKey, packetStateColorScheme, type PacketStateKey } from '@/lib/packet-state-colors';
import { packetStatusFromLaneStatus, type CanonicalPacketStatus } from '@/lib/orchestrator/packet-state';
import type { LaneStatus as CanonicalLaneStatus } from '@/lib/lane/types';
import type { LaneStatus, VisualStatus } from './AgentPanelExtraAgentRow';

export interface SpawnedAgentState {
  canonical: CanonicalPacketStatus | null;
  stateKey: PacketStateKey;
  label: string;
  color: string;
}

export function deriveSpawnedAgentState(
  laneStatus: LaneStatus | null | undefined,
  visualStatus: VisualStatus,
  lastEventLabel: string | null | undefined,
  outcome?: 'no_changes' | 'merged' | 'discarded' | null,
): SpawnedAgentState {
  const canonical = laneStatus === 'awaiting_human'
    ? 'blocked'
    : packetStatusFromLaneStatus(laneStatus as CanonicalLaneStatus | null | undefined);
  const stateKey = laneStatusToStateKey(laneStatus);
  const scheme = packetStateColorScheme(stateKey);
  let label = scheme.label ?? 'Idle';

  if (outcome === 'no_changes') label = 'Finished — no changes';
  if (outcome === 'merged') label = 'Merged';
  if (outcome === 'discarded') label = 'Discarded';
  if (canonical === 'awaiting_review') label = lastEventLabel === 'pr_created' ? 'PR open' : 'Review ready';
  if (canonical === 'blocked') label = laneStatus === 'awaiting_input' ? 'Needs input' : 'Blocked';
  if (canonical === 'recovering') label = 'Recovering';
  if (canonical === 'released') label = 'Merged';
  if (canonical === 'archived' && !outcome) label = 'Archived';
  if (canonical === 'idle') label = 'Idle';
  if (!canonical && visualStatus === 'waiting') label = 'Review ready';
  if (!canonical && visualStatus === 'error') label = 'Failed';
  if (!canonical && visualStatus === 'running') label = 'Running';

  return {
    canonical,
    stateKey,
    label,
    color: scheme.rowAccent === 'transparent' ? 'var(--t-text-faint)' : scheme.rowAccent,
  };
}

export function formatSpawnedAgentElapsed(startUnixMs: number | null | undefined, now = Date.now()): string {
  if (!startUnixMs) return 'No activity yet';
  const delta = Math.max(0, now - startUnixMs);
  const seconds = Math.floor(delta / 1000);
  if (seconds < 60) return `${seconds}s elapsed`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s elapsed`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, '0')}m elapsed`;
}
