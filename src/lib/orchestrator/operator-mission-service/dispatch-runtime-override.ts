import { resolveWorkerRouting } from '@/lib/agents/routing';
import {
  formatDispatchableRuntimeChoices,
  isDispatchableRuntime,
} from '@/lib/orchestrator/runtime-capabilities';
import type { OrchestratorMissionState, OrchestratorPacket, OrchestratorRuntime } from '@/lib/orchestrator/types';
import { rearmHeldPacketsForExplicitDispatch } from './dispatch-result';

export { summarizeDispatchMission } from './dispatch-result';

function canApplyRuntimeOverride(packet: OrchestratorPacket): boolean {
  if (packet.queueState !== 'queued' || packet.lane) return false;
  if (packet.archivedAt || packet.releaseState === 'released' || packet.operatorStopped) return false;
  return packet.status !== 'archived'
    && packet.status !== 'failed'
    && packet.status !== 'launching'
    && packet.status !== 'running'
    && packet.status !== 'awaiting_review';
}

/** Rearm reset packets and durably stamp an explicit per-dispatch runtime. */
export function preparePacketsForExplicitDispatch(
  state: OrchestratorMissionState,
  runtime?: OrchestratorRuntime,
): void {
  rearmHeldPacketsForExplicitDispatch(state);
  if (runtime === undefined) return;
  if (!isDispatchableRuntime(runtime)) {
    throw new Error(`runtime must be one of ${formatDispatchableRuntimeChoices()}`);
  }
  state.runtime = runtime;

  for (const packet of state.packets) {
    if (!canApplyRuntimeOverride(packet)) continue;
    const workerRouting = resolveWorkerRouting({
      workerIntent: packet.workerIntent,
      requestedProvider: packet.workerRouting?.requestedProvider,
      requestedRuntime: runtime,
      requestedModel: packet.workerRouting?.requestedModel ?? packet.assignedModel,
      requestedEffort: packet.workerRouting?.requestedEffort,
      confidence: packet.workerRouting?.confidence,
      source: 'dispatch-mission-override',
    });
    packet.runtime = workerRouting.selectedRuntime;
    packet.assignedModel = workerRouting.selectedModel;
    packet.workerIntent = workerRouting.workerIntent;
    packet.workerRouting = workerRouting;
    packet.dispatchRuntimePin = runtime;
  }
}
