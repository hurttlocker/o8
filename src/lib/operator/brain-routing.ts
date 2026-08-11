import 'server-only';

import { resolveCodexReasoningEffort } from '@/lib/codex/reasoning-effort';
import type { ThinkingEffort } from '@/lib/orchestrator/thinking-effort';
import { getOperatorDefaultsSync } from './defaults';

/** Whether the configured subscription profile permits Claude Brain calls. */
export function resolveBrainUseClaudeCliSync(): boolean {
  const values = getOperatorDefaultsSync().values;
  return values.subscriptionProfile !== 'codex-only' && values.brainUseClaudeCli;
}

/** Whether the configured subscription profile permits Codex Brain calls. */
export function resolveBrainUseCodexCliSync(): boolean {
  return getOperatorDefaultsSync().values.subscriptionProfile !== 'claude-only';
}

export interface BrainCodexRoute {
  model: string;
  reasoningEffort?: Exclude<ThinkingEffort, 'adaptive'>;
}

/** Resolve the Brain-only Codex model and effort independently of worker defaults. */
export function resolveBrainCodexRouteSync(): BrainCodexRoute {
  const values = getOperatorDefaultsSync().values;
  const configuredEffort = values.brainCodexEffort === 'adaptive'
    ? values.codexWorkerEffort
    : values.brainCodexEffort;
  const reasoningEffort = configuredEffort === 'adaptive'
    ? undefined
    : resolveCodexReasoningEffort(configuredEffort, values.brainCodexModel) as BrainCodexRoute['reasoningEffort'];
  return {
    model: values.brainCodexModel,
    ...(reasoningEffort ? { reasoningEffort } : {}),
  };
}
