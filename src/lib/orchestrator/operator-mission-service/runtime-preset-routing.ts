import type { OrchestratorRuntime } from '@/lib/orchestrator/types';
import { resolveRuntimePreset, type RuntimePresetId } from '@/lib/orchestrator/runtime-capabilities';

/** Resolve a semantic preset for one runtime without leaking cross-runtime model ids. */
export function resolveRuntimePresetModel(
  preset: RuntimePresetId | undefined,
  runtime: OrchestratorRuntime,
  fallback: string | null | undefined,
  carrier?: unknown,
) {
  if (!preset) return fallback;
  if (runtime === 'claude-code' && carrier) return null;
  // A runtime with no preset entry keeps the caller's model: the preset is a
  // hint for runtimes it knows, never a reason to drop the operator's routing.
  return resolveRuntimePreset(preset, runtime)?.model ?? fallback;
}
