import { randomUUID } from 'node:crypto';

import { normalizeOrchestratorMissionState } from '@/lib/orchestrator/store';
import { QUALITY_SEARCH_ROLES } from '@/lib/orchestrator/quality-search';
import type { OrchestratorMissionState, OrchestratorPacket } from '@/lib/orchestrator/types';
import { releaseAbandonedMissionLifecycleHold } from '@/lib/orchestrator/mission-lifecycle-hold';

/**
 * Best-of-N fan-out.
 *
 * A pure mission-state transform, kept in its own leaf module (depends only on
 * the state types + the normalize store) so it stays testable without dragging in
 * the dispatch-heavy `scheduling.ts` graph. `runDispatchTick` calls it at the top
 * of every tick; the operator arms it by passing `comparisonModels` to
 * `create_mission`, which stamps the seed packet.
 */

function buildComparisonGroupId(qualitySearch: boolean) {
  return `${qualitySearch ? 'quality' : 'cmp'}-${Date.now()}-${randomUUID().slice(0, 8)}`;
}

/**
 * Split every seed packet carrying `comparisonModels` into N sibling candidates —
 * one per model, each with its own id/branch suffix (`-cmp-<i>`), a shared
 * `comparisonGroupId`, `comparisonIndex`, and `assignedModel` set — so each
 * dispatches into its own worktree/lane. The seed's `comparisonModels` is consumed
 * (cleared on the siblings) so the fan-out is idempotent. Returns the SAME state
 * reference when nothing fans out (no churn).
 */
export function fanOutComparisonPackets(state: OrchestratorMissionState): OrchestratorMissionState {
  state = releaseAbandonedMissionLifecycleHold(state);
  if (state.lifecycleHold) return state;
  const activeComparisonGroups = new Set(state.activeComparisonGroups ?? []);
  const nextPackets: OrchestratorPacket[] = [];
  let changed = false;

  for (const packet of state.packets) {
    const qualitySearchSeed = packet.qualitySearch?.version === 1
      && packet.qualitySearch.role === null
      && Boolean(packet.taskContract)
      && !packet.comparisonGroupId;
    const configuredModels = (packet.comparisonModels ?? [])
      .map((model) => model.trim())
      .filter(Boolean);
    const qualitySearchModel = packet.workerRouting?.selectedModel
      ?? packet.assignedModel
      ?? packet.runtime;
    const comparisonModels = qualitySearchSeed
      ? [qualitySearchModel, qualitySearchModel]
      : configuredModels;
    const shouldFanOut = comparisonModels.length > 0 && !packet.comparisonGroupId;

    if (!shouldFanOut) {
      nextPackets.push(packet);
      continue;
    }

    changed = true;
    const comparisonGroupId = buildComparisonGroupId(qualitySearchSeed);
    activeComparisonGroups.add(comparisonGroupId);
    console.log(
      `[best-of-n] Fanning out ${packet.id} into ${comparisonModels.length} comparison lane${comparisonModels.length === 1 ? '' : 's'} (${comparisonModels.join(', ')})`,
    );

    comparisonModels.forEach((model, index) => {
      const qualitySearchRole = qualitySearchSeed ? QUALITY_SEARCH_ROLES[index] : undefined;
      nextPackets.push({
        ...packet,
        id: `${packet.id}-cmp-${index}`,
        title: qualitySearchRole
          ? `${packet.title} (${qualitySearchRole === 'minimal_complete' ? 'smallest complete' : 'robustness'})`
          : `${packet.title} (${model})`,
        branchTarget: `${packet.branchTarget}-cmp-${index}`,
        queueState: 'queued',
        releaseState: 'pending',
        status: 'queued',
        blockedReason: null,
        lastEventAt: null,
        lastEventLabel: null,
        archivedAt: null,
        review: null,
        lane: null,
        comparisonModels: undefined,
        comparisonGroupId,
        comparisonIndex: index,
        assignedModel: model,
        ...(qualitySearchRole
          ? {
              qualitySearch: {
                version: 1 as const,
                role: qualitySearchRole,
                repairAttempts: packet.qualitySearch?.repairAttempts ?? 0,
              },
            }
          : {}),
      });
    });
  }

  if (!changed) {
    return state;
  }

  return normalizeOrchestratorMissionState({
    ...state,
    packets: nextPackets,
    activeComparisonGroups: [...activeComparisonGroups],
    updatedAt: new Date().toISOString(),
  });
}
