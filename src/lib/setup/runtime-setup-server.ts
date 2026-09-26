import 'server-only';
import { homedir } from 'node:os';
import { opencodeCliModels, readOpencodeConfig } from '@/lib/runtimes/shared/opencode-readiness';
import type { OperatorDefaultsWithSources } from '@/lib/operator/defaults';
import { readLocalLeadModels, readRuntimeActivity } from './runtime-activity';
import { recommendRuntimeSetup, type SetupRuntime } from './runtime-recommendation';

export async function readRuntimeSetupRecommendation(data: OperatorDefaultsWithSources, inventory: readonly SetupRuntime[]) {
  const [activity, localLeadModels] = await Promise.all([readRuntimeActivity(), readLocalLeadModels()]);
  let opencodeModel: string | undefined;
  if (inventory.some((item) => item.id === 'opencode' && item.available)) {
    const [config, models] = await Promise.all([readOpencodeConfig(homedir()).catch(() => ({} as { model?: string })), opencodeCliModels().catch(() => null)]);
    if (typeof config.model === 'string' && models?.has(config.model)) opencodeModel = config.model;
  }
  return recommendRuntimeSetup({ inventory, activity, values: data.values, sources: data.sources, localLeadModels, opencodeModel });
}
