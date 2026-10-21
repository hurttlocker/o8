import { getDispatchableRuntimeAvailability, getRuntimeAuthSnapshot } from '@/lib/runtimes/shared/auth-detect';
import type { OrchestratorRuntime } from '@/lib/orchestrator/types';

/**
 * A caller-facing reason when the requested worker runtime is not installed on
 * this machine, else null. Only a missing install refuses here; sign-in and
 * other readiness problems keep the launch path, which reports them itself.
 * The `pi` runtime is the operator's own Pi CLI, so its reason names the
 * built-in Pi worker an orchestrator most likely meant (#3664).
 */
export async function runtimeNotInstalledReason(runtime: OrchestratorRuntime): Promise<string | null> {
  const availability = (await getDispatchableRuntimeAvailability(await getRuntimeAuthSnapshot()))
    .find((entry) => entry.id === runtime);
  if (availability?.unavailableReason !== 'not_installed') return null;
  const hint = runtime === 'pi'
    ? 'The built-in Pi worker that ships with o8 is runtime "pi-builtin".'
    : 'Choose an installed runtime, or omit runtime to use the saved dispatch default.';
  return `Worker runtime "${runtime}" is not installed on this machine: ${availability.detail} ${hint}`;
}
