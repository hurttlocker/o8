import type { OrchestratorRuntime } from '@/lib/orchestrator/runtime-capabilities';
import { getRuntimeCapability } from '@/lib/orchestrator/runtime-capabilities';
import {
  isWorkerStartMode,
  type WorkerStartMode,
} from '@/lib/operator/worker-start-mode';

export interface ComposerWorkerDefaults {
  defaultDispatchRuntime: OrchestratorRuntime;
  defaultDispatchModel: string;
  opencodeWorkerModel: string | null;
  threecodeWorkerModel: string | null;
  workerStartMode: WorkerStartMode;
}

export const FALLBACK_COMPOSER_WORKER_DEFAULTS: ComposerWorkerDefaults = {
  defaultDispatchRuntime: 'codex',
  defaultDispatchModel: '',
  opencodeWorkerModel: null,
  threecodeWorkerModel: null,
  workerStartMode: 'autonomous',
};

export function normalizeComposerWorkerDefaults(
  values: Partial<ComposerWorkerDefaults>,
): ComposerWorkerDefaults {
  return {
    defaultDispatchRuntime: values.defaultDispatchRuntime ?? 'codex',
    defaultDispatchModel: typeof values.defaultDispatchModel === 'string'
      ? values.defaultDispatchModel
      : '',
    opencodeWorkerModel: typeof values.opencodeWorkerModel === 'string' && values.opencodeWorkerModel
      ? values.opencodeWorkerModel
      : null,
    threecodeWorkerModel: typeof values.threecodeWorkerModel === 'string' && values.threecodeWorkerModel
      ? values.threecodeWorkerModel
      : null,
    workerStartMode: isWorkerStartMode(values.workerStartMode)
      ? values.workerStartMode
      : 'autonomous',
  };
}

export function shortWorkerModelLabel(model: string): string {
  const cut = model.lastIndexOf('/');
  return cut >= 0 ? model.slice(cut + 1) : model;
}

export function workerModelForDisplay(
  runtime: OrchestratorRuntime,
  defaults: ComposerWorkerDefaults,
): string {
  if (runtime === 'opencode' && defaults.opencodeWorkerModel) {
    return defaults.opencodeWorkerModel;
  }
  if (runtime === '3code' && defaults.threecodeWorkerModel) {
    return defaults.threecodeWorkerModel;
  }
  if (defaults.defaultDispatchModel && runtime === defaults.defaultDispatchRuntime) {
    return defaults.defaultDispatchModel;
  }
  return getRuntimeCapability(runtime).defaultModel ?? '';
}
