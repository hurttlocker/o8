import type { OrchestratorBackendSetting } from '@/lib/operator/backend-setting';

export type ClaudeHarnessModelSource = 'native' | 'openrouter' | 'codex-subscription';

export function resolveEffectiveOrchestratorModel(input: {
  backend: OrchestratorBackendSetting | null | undefined;
  configuredModel: string | null | undefined;
  inAppOrchestratorEnabled?: boolean;
  harnessSource?: ClaudeHarnessModelSource | null;
  harnessModel?: string | null;
}): string | null {
  const configuredModel = input.configuredModel?.trim() || null;
  const harnessModel = input.harnessModel?.trim() || null;
  const resolvesToClaude = input.backend === 'claude'
    || (input.backend === 'auto' && input.inAppOrchestratorEnabled === true);
  if (resolvesToClaude && input.harnessSource && input.harnessSource !== 'native' && harnessModel) {
    return harnessModel;
  }
  return configuredModel;
}
