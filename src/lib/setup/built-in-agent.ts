import type { OrchestratorBackendSetting } from '@/lib/operator/backend-setting';
import type { OrchestratorRuntime } from '@/lib/orchestrator/runtime-capabilities';
import type { SetupRuntime } from './runtime-recommendation';

export interface BuiltInAgentRegistration {
  id: OrchestratorRuntime;
  backend: Exclude<OrchestratorBackendSetting, 'auto'>;
}

// TODO(#3258): reference the registered bundled runtime and backend here.
// Null keeps production off. The external Pi CLI runtime must not fill this slot.
export const BUILT_IN_AGENT_REGISTRATION: BuiltInAgentRegistration | null = null;

export function createBuiltInAgentRuntime(registration: BuiltInAgentRegistration, platform: string): SetupRuntime {
  const available = platform === 'darwin' || platform === 'linux';
  return {
    id: registration.id,
    label: 'Built-in agent (Pi)',
    available,
    installed: true,
    unavailableReason: available ? null : 'unsupported_platform',
    detail: available
      ? 'Uses the configured runtime. Asks before file writes and commands; workspace rules can allow commands.'
      : 'Available on macOS and Linux. Windows support is not available yet.',
    fix: '',
    builtIn: {
      backend: registration.backend,
      planDetail: 'Uses the configured model connection. Availability and usage limits are checked when a request starts.',
    },
  };
}

export function builtInAgentFromInventory(inventory: readonly SetupRuntime[]): SetupRuntime | undefined {
  return inventory.find((item) => item.builtIn && item.id !== 'pi');
}

export function setupRuntimeLabel(backend: OrchestratorBackendSetting, inventory: readonly SetupRuntime[]): string | undefined {
  return inventory.find((item) => item.builtIn?.backend === backend)?.label;
}
