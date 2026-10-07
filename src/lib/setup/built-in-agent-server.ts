import 'server-only';
import { getEntitlementSync } from '@/lib/entitlement/store';
import { listDispatchableRuntimes } from '@/lib/orchestrator/runtime-capabilities';
import { BUILT_IN_AGENT_REGISTRATION, createBuiltInAgentRuntime } from './built-in-agent';
import type { SetupRuntime } from './runtime-recommendation';
import type { OperatorDefaultsWithSources } from '@/lib/operator/defaults';
import { readRuntimeSetupRecommendation } from './runtime-setup-server';

/** Read the bundled registration without scanning or signing in to a CLI. */
export async function readBuiltInAgentRuntime(): Promise<SetupRuntime | null> {
  const registration = BUILT_IN_AGENT_REGISTRATION;
  if (!registration || registration.id === 'pi' || !listDispatchableRuntimes().includes(registration.id)) return null;
  const [{ getRuntime }, { getOrchestratorBackend }] = await Promise.all([
    import('@/lib/runtimes'), import('@/lib/lane/orchestrator-backends/registry'),
  ]);
  if (!getRuntime(registration.id)?.capabilities.launch
    || getOrchestratorBackend(registration.backend).id !== registration.backend) return null;
  return createBuiltInAgentRuntime(registration, getEntitlementSync().plan, process.platform);
}

/** Never add a selectable runtime that the discovery registry did not list. */
export function applyBuiltInAgentRuntime<T extends SetupRuntime>(inventory: readonly T[], builtIn: SetupRuntime | null): SetupRuntime[] {
  return inventory.map((item) => builtIn && item.id === builtIn.id ? builtIn : item);
}

export async function readOnboardingRuntimeSetup(data: OperatorDefaultsWithSources, inventory: readonly SetupRuntime[]) {
  const dispatchableRuntimes = applyBuiltInAgentRuntime(inventory, await readBuiltInAgentRuntime());
  return { dispatchableRuntimes, setupRecommendation: await readRuntimeSetupRecommendation(data, dispatchableRuntimes) };
}
