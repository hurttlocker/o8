import { parseLocalModel } from '@/lib/codex/local-model';
import { modelBelongsToRuntime } from '@/lib/lane/orchestrator-model-guard';
import {
  getRuntimeCapability,
  ORCHESTRATOR_RUNTIMES,
  type OrchestratorRuntime,
} from '@/lib/orchestrator/runtime-capabilities';

function cleanModel(model: string | null | undefined): string | null {
  const trimmed = model?.trim();
  return trimmed || null;
}

export function validateRuntimeModelSelection(
  runtime: OrchestratorRuntime,
  model: string | null | undefined,
  fieldLabel: string,
): string | null {
  const selected = cleanModel(model);
  if (!selected) return null;
  if (runtime === 'codex' && parseLocalModel(selected)) return null;
  if (modelBelongsToRuntime(selected, runtime)) return null;
  const recognizedHouses = new Set(
    (Object.keys(ORCHESTRATOR_RUNTIMES) as OrchestratorRuntime[])
      .filter((candidate) => getRuntimeCapability(candidate).modelIdPattern?.test(selected))
      .map((candidate) => getRuntimeCapability(candidate).authHouse)
      .filter((house): house is NonNullable<typeof house> => house !== null),
  );
  const selectedHouse = getRuntimeCapability(runtime).authHouse;
  if (recognizedHouses.size === 0 || selectedHouse === null || recognizedHouses.has(selectedHouse)) return null;
  return `${fieldLabel} model "${selected}" is not compatible with ${getRuntimeCapability(runtime).label}.`;
}
