import type {
  DispatchRuntime,
  OperatorDefaultsResponse,
  OrchestratorBackendSetting,
} from '@/components/desktop/settings/dispatch-shared';

import { recommendRuntimeSetup, type RuntimeSetupRecommendation, type SetupRuntime } from '@/lib/setup/runtime-recommendation';
import { invalidateRuntimeInventory } from './useRuntimeInventory';
import { invalidateOperatorDefaultsValuesSnapshot } from '@/lib/operator/operator-defaults-values-client';

export type OnboardingOrchestratorRuntime = Exclude<OrchestratorBackendSetting, 'claude'> | 'claude-code';

export type DispatchableRuntimeInventoryItem = SetupRuntime;

export interface OnboardingRuntimeSelection {
  inventory: DispatchableRuntimeInventoryItem[];
  orchestratorRuntime: OnboardingOrchestratorRuntime;
  workerRuntimes: DispatchRuntime[];
  recommendation: RuntimeSetupRecommendation;
  sources: OperatorDefaultsResponse['sources'];
}

type OnboardingFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export function orchestratorBackendForRuntime(
  runtime: OnboardingOrchestratorRuntime,
): OrchestratorBackendSetting {
  return runtime === 'claude-code' ? 'claude' : runtime;
}

export function canSelectOnboardingRuntime(
  inventory: DispatchableRuntimeInventoryItem[],
  runtime: DispatchRuntime,
): boolean {
  return inventory.some((item) => item.id === runtime && item.available);
}

export function toggleOnboardingWorkerRuntime(
  selected: DispatchRuntime[],
  runtime: DispatchRuntime,
  inventory: DispatchableRuntimeInventoryItem[],
): DispatchRuntime[] {
  if (selected.includes(runtime)) {
    return selected.length > 1 ? selected.filter((item) => item !== runtime) : selected;
  }
  if (!canSelectOnboardingRuntime(inventory, runtime)) return selected;
  return [...selected, runtime];
}

export async function loadOnboardingRuntimeSelection(
  request: OnboardingFetch = fetch,
  refresh = false,
): Promise<OnboardingRuntimeSelection> {
  const response = await request(`/api/panel/operator-defaults?include=setup${refresh ? '&refresh=runtime' : ''}`, { cache: 'no-store' });
  const payload = await response.json().catch(() => null) as (OperatorDefaultsResponse & { setupRecommendation?: RuntimeSetupRecommendation }) | { error?: string } | null;
  if (!response.ok || !payload || !('values' in payload)) {
    const message = payload && 'error' in payload && typeof payload.error === 'string'
      ? payload.error
      : `Runtime inventory failed (${response.status})`;
    throw new Error(message);
  }
  const inventory = payload.dispatchableRuntimes ?? [];
  const recommendation = payload.setupRecommendation ?? recommendRuntimeSetup({
    inventory, values: payload.values, sources: payload.sources,
    activity: { codex: 0, claude: 0, complete: false },
  });
  return {
    inventory, recommendation, sources: payload.sources ?? {} as OperatorDefaultsResponse['sources'],
    orchestratorRuntime: recommendation.backend === 'claude' ? 'claude-code' : recommendation.backend ?? 'codex',
    workerRuntimes: recommendation.workerRuntimes,
  };
}

export async function persistOnboardingRuntimeSelection(
  selection: Pick<OnboardingRuntimeSelection, 'orchestratorRuntime' | 'workerRuntimes'> & { leadModel?: string; workerModel?: string },
  request: OnboardingFetch = fetch,
): Promise<void> {
  if (selection.workerRuntimes.length === 0) {
    throw new Error('Choose at least one available worker runtime.');
  }
  const response = await request('/api/panel/operator-defaults', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      orchestratorBackend: orchestratorBackendForRuntime(selection.orchestratorRuntime),
      defaultDispatchRuntime: selection.workerRuntimes[0],
      workerRuntimes: selection.workerRuntimes,
      ...(selection.leadModel && (selection.orchestratorRuntime === 'codex' || selection.orchestratorRuntime === 'claude-code') ? { orchestratorModel: selection.leadModel } : {}),
      ...(selection.workerModel !== undefined ? selection.workerRuntimes[0] === 'opencode'
        ? { opencodeWorkerModel: selection.workerModel || null }
        : { defaultDispatchModel: selection.workerModel } : {}),
    }),
  });
  const payload = await response.json().catch(() => null) as { error?: string } | null;
  if (!response.ok) {
    throw new Error(payload?.error ?? `Save failed (${response.status})`);
  }
  invalidateOperatorDefaultsValuesSnapshot();
  invalidateRuntimeInventory();
}
