import { isPlausibleAcpModelId, normalizeAcpModelId } from '@/lib/orchestrator/acp-model-id';
import { isPlausibleThreecodeModelId } from '@/lib/runtimes/threecode-model-catalogue';
import type { OperatorDefaults } from './defaults';

type ModelPinUpdates = Partial<Pick<OperatorDefaults,
  'opencodeOrchestratorModel' | 'opencodeWorkerModel' | 'threecodeWorkerModel'
>>;

/** Invalid stored pins fall back to the runtime default. */
export function normalizeStoredModelPins(stored: ModelPinUpdates): ModelPinUpdates {
  const normalized: ModelPinUpdates = {};
  for (const key of ['opencodeOrchestratorModel', 'opencodeWorkerModel'] as const) {
    const value = normalizeAcpModelId(stored[key]);
    if (value) normalized[key] = value;
  }
  if (stored.threecodeWorkerModel === null) normalized.threecodeWorkerModel = null;
  else if (isPlausibleThreecodeModelId(stored.threecodeWorkerModel)) {
    normalized.threecodeWorkerModel = stored.threecodeWorkerModel.trim();
  }
  return normalized;
}

/** Validate model pins before applying them to stored operator defaults. */
export function normalizeModelPinUpdates(update: ModelPinUpdates): ModelPinUpdates {
  const normalized: ModelPinUpdates = {};
  for (const key of ['opencodeOrchestratorModel', 'opencodeWorkerModel'] as const) {
    const value = update[key];
    if (value === undefined) continue;
    if (value === null) { normalized[key] = null; continue; }
    if (!isPlausibleAcpModelId(value)) {
      throw new Error(
        `${key} ${JSON.stringify(value)} is not a usable model id. Expect provider/model, optionally with a /low or /high suffix — pick one from the model list rather than typing it.`,
      );
    }
    normalized[key] = value.trim();
  }
  if (update.threecodeWorkerModel !== undefined) {
    if (update.threecodeWorkerModel === null) normalized.threecodeWorkerModel = null;
    else if (!isPlausibleThreecodeModelId(update.threecodeWorkerModel)) {
      throw new Error('threecodeWorkerModel must be a configured 3code model id selected from the model list.');
    } else {
      normalized.threecodeWorkerModel = update.threecodeWorkerModel.trim();
    }
  }
  return normalized;
}
