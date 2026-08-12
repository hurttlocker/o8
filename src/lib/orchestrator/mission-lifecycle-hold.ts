import type { OrchestratorMissionState } from '@/lib/orchestrator/types';

const MISSION_LIFECYCLE_HOLD_LEASE_MS = 30 * 60 * 1000;

export function createMissionLifecycleHold(
  source: string,
): NonNullable<OrchestratorMissionState['lifecycleHold']> {
  const now = Date.now();
  return {
    source,
    reason: 'operator_stop',
    startedAt: new Date(now).toISOString(),
    ownerPid: process.pid,
    leaseExpiresAt: new Date(now + MISSION_LIFECYCLE_HOLD_LEASE_MS).toISOString(),
  };
}

export function missionLifecycleHoldIsActive(
  hold: OrchestratorMissionState['lifecycleHold'],
  now = Date.now(),
): boolean {
  if (!hold) return false;
  const expiresAt = Date.parse(hold.leaseExpiresAt);
  return Number.isFinite(expiresAt) && expiresAt > now;
}

export function releaseAbandonedMissionLifecycleHold(
  state: OrchestratorMissionState,
  options: { allowOwnerTakeover?: boolean } = {},
): OrchestratorMissionState {
  if (!state.lifecycleHold) return state;
  const ownerRestarted = options.allowOwnerTakeover && state.lifecycleHold.ownerPid !== process.pid;
  if (!ownerRestarted && missionLifecycleHoldIsActive(state.lifecycleHold)) return state;
  return {
    ...state,
    lifecycleHold: null,
    updatedAt: new Date().toISOString(),
  };
}
