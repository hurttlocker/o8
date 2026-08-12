import { reconcileOrchestratorControlPlaneState, withLockedState } from '@/lib/orchestrator/control-plane';
import { withMissionHandoffBarrier } from '@/lib/orchestrator/lifecycle-mutation-lock';
import { releaseAbandonedMissionLifecycleHold } from '@/lib/orchestrator/mission-lifecycle-hold';
import { withMissionRegistryState } from '@/lib/orchestrator/mission-registry';
import { rearmHeldPacketsForExplicitDispatch } from './dispatch-result';
import { resolveMissionDispatchTarget } from './mission';
import { currentMissionState } from './shared';
import type { DispatchMissionInput } from './types';

/**
 * Durably admits an asynchronous dispatch before the HTTP receipt is finalized.
 * A process exit after this returns can delay the launch until the next headless
 * tick, but cannot lose an explicit re-arm of packets held by reset/retry.
 */
export async function prepareMissionDispatch(input: DispatchMissionInput) {
  return withMissionHandoffBarrier(async () => {
    const requestedMissionId = resolveMissionDispatchTarget(input.missionId);
    const current = currentMissionState();
    if (requestedMissionId !== current.missionId?.trim()) {
      const { state } = await withMissionRegistryState(requestedMissionId, async (stored) => {
        const prepared = releaseAbandonedMissionLifecycleHold(
          reconcileOrchestratorControlPlaneState(stored),
          { allowOwnerTakeover: true },
        );
        if (!prepared.lifecycleHold) rearmHeldPacketsForExplicitDispatch(prepared);
        return { state: prepared, result: undefined };
      });
      return { missionId: requestedMissionId, blocked: Boolean(state.lifecycleHold) };
    }

    const { state } = await withLockedState(async (stored) => {
      const prepared = releaseAbandonedMissionLifecycleHold(stored, { allowOwnerTakeover: true });
      if (!prepared.lifecycleHold) rearmHeldPacketsForExplicitDispatch(prepared);
      Object.assign(stored, prepared);
    });
    return { missionId: requestedMissionId, blocked: Boolean(state.lifecycleHold) };
  });
}
