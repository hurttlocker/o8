import type {
  DispatchRuntime,
  OperatorDefaultsResponse,
  OrchestratorBackendSetting,
} from '@/components/desktop/settings/dispatch-shared';

export type OnboardingOrchestratorRuntime = 'codex' | 'claude-code';

export interface DispatchableRuntimeInventoryItem {
  id: DispatchRuntime;
  label: string;
  available: boolean;
  unavailableReason: 'not_installed' | 'needs_auth' | 'adapter_unavailable' | null;
  detail: string;
  fix: string;
}

export interface OnboardingRuntimeSelection {
  inventory: DispatchableRuntimeInventoryItem[];
  orchestratorRuntime: OnboardingOrchestratorRuntime;
  workerRuntimes: DispatchRuntime[];
}

type OnboardingFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export function orchestratorBackendForRuntime(
  runtime: OnboardingOrchestratorRuntime,
): Extract<OrchestratorBackendSetting, 'codex' | 'claude'> {
  return runtime === 'claude-code' ? 'claude' : 'codex';
}

function orchestratorRuntimeForBackend(value: unknown): OnboardingOrchestratorRuntime | null {
  if (value === 'claude') return 'claude-code';
  if (value === 'codex') return 'codex';
  return null;
}

function availableRuntimeIds(inventory: DispatchableRuntimeInventoryItem[]): Set<DispatchRuntime> {
  return new Set(inventory.filter((runtime) => runtime.available).map((runtime) => runtime.id));
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
  if (!canSelectOnboardingRuntime(inventory, runtime)) return selected;
  if (selected.includes(runtime)) {
    return selected.length > 1 ? selected.filter((item) => item !== runtime) : selected;
  }
  return [...selected, runtime];
}

function initialWorkerRuntimes(
  values: OperatorDefaultsResponse['values'],
  inventory: DispatchableRuntimeInventoryItem[],
): DispatchRuntime[] {
  const available = availableRuntimeIds(inventory);
  const persisted = Array.isArray(values.workerRuntimes)
    ? values.workerRuntimes.filter((runtime): runtime is DispatchRuntime => available.has(runtime))
    : [];
  if (persisted.length > 0) return [...new Set(persisted)];
  if (available.has(values.defaultDispatchRuntime)) return [values.defaultDispatchRuntime];
  if (available.has('codex')) return ['codex'];
  const firstAvailable = inventory.find((runtime) => runtime.available);
  return firstAvailable ? [firstAvailable.id] : [];
}

function initialOrchestratorRuntime(
  values: OperatorDefaultsResponse['values'],
  inventory: DispatchableRuntimeInventoryItem[],
): OnboardingOrchestratorRuntime {
  const available = availableRuntimeIds(inventory);
  const persisted = orchestratorRuntimeForBackend(values.orchestratorBackend);
  if (persisted && available.has(persisted)) return persisted;
  if (available.has('codex')) return 'codex';
  if (available.has('claude-code')) return 'claude-code';
  return 'codex';
}

export async function loadOnboardingRuntimeSelection(
  request: OnboardingFetch = fetch,
): Promise<OnboardingRuntimeSelection> {
  const response = await request('/api/panel/operator-defaults', { cache: 'no-store' });
  const payload = await response.json().catch(() => null) as OperatorDefaultsResponse | { error?: string } | null;
  if (!response.ok || !payload || !('values' in payload)) {
    const message = payload && 'error' in payload && typeof payload.error === 'string'
      ? payload.error
      : `Runtime inventory failed (${response.status})`;
    throw new Error(message);
  }
  const inventory = payload.dispatchableRuntimes ?? [];
  return {
    inventory,
    orchestratorRuntime: initialOrchestratorRuntime(payload.values, inventory),
    workerRuntimes: initialWorkerRuntimes(payload.values, inventory),
  };
}

export async function persistOnboardingRuntimeSelection(
  selection: Pick<OnboardingRuntimeSelection, 'orchestratorRuntime' | 'workerRuntimes'>,
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
    }),
  });
  const payload = await response.json().catch(() => null) as { error?: string } | null;
  if (!response.ok) {
    throw new Error(payload?.error ?? `Save failed (${response.status})`);
  }
}
