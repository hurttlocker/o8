import type { OrchestratorRuntime } from '@/lib/orchestrator/types';
import type { OrchestratorBackendSetting } from '@/lib/operator/backend-setting';
import { leadModelPreset } from './runtime-recommendation';

export type SetupLeadRuntime = Exclude<OrchestratorBackendSetting, 'claude'> | 'claude-code';
export interface RuntimeSelection {
  orchestratorRuntime: SetupLeadRuntime;
  workerRuntimes: OrchestratorRuntime[];
  leadModel?: string;
  workerModel?: string;
}

export function runtimeSelectionUpdate(selection: RuntimeSelection) {
  if (!selection.workerRuntimes.length) throw new Error('Choose at least one available worker runtime.');
  const backend = selection.orchestratorRuntime === 'claude-code' ? 'claude' : selection.orchestratorRuntime;
  if (selection.leadModel && backend !== 'claude' && backend !== 'opencode'
    && selection.leadModel !== leadModelPreset(backend)) {
    throw new Error('This lead uses its runtime model default. Choose a different model in the conversation.');
  }
  return {
    orchestratorBackend: backend,
    defaultDispatchRuntime: selection.workerRuntimes[0],
    workerRuntimes: [...new Set(selection.workerRuntimes)],
    ...(selection.leadModel && backend === 'claude' ? { orchestratorModel: selection.leadModel } : {}),
    ...(selection.leadModel !== undefined && backend === 'opencode' ? { opencodeOrchestratorModel: selection.leadModel || null } : {}),
    ...(selection.workerModel !== undefined ? selection.workerRuntimes[0] === 'opencode'
      ? { opencodeWorkerModel: selection.workerModel || null }
      : { defaultDispatchModel: selection.workerModel } : {}),
  };
}
