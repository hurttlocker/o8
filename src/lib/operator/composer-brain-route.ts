import 'server-only';

import { detectRuntimeAuthStatus } from '@/lib/runtimes/shared/auth-detect';
import { MODEL_IDS } from '@/lib/models';
import { getOperatorDefaultsSync } from './defaults';

import type { ComposerBrainRoute } from './composer-brain-context';
export { withComposerBrainRoute } from './composer-brain-context';

/** Resolve only an authenticated connection; discovery never starts an answer. */
export async function resolveComposerBrainRoute(preferred?: string): Promise<ComposerBrainRoute> {
  const { values, sources } = getOperatorDefaultsSync();
  const first = preferred === 'claude' || preferred === 'claude-code' ? 'claude-code'
    : preferred === 'codex' ? 'codex' : values.orchestratorBackend === 'claude' ? 'claude-code' : 'codex';
  const order = first === 'codex' ? ['codex', 'claude-code'] as const : ['claude-code', 'codex'] as const;
  for (const runtime of order) {
    if (runtime === 'codex' && values.subscriptionProfile === 'claude-only') continue;
    if (runtime === 'claude-code' && (values.subscriptionProfile === 'codex-only' || !values.brainUseClaudeCli)) continue;
    const status = await detectRuntimeAuthStatus(runtime).catch(() => null);
    if (!status?.ready || !status.installed || !status.binaryPath || !status.authenticated || status.nativeSignInBlocked) continue;
    return { runtime, binary: status.binaryPath, model: runtime === 'codex'
      ? sources.brainCodexModel === 'default' ? MODEL_IDS.codexWorkerDefault : values.brainCodexModel
      : MODEL_IDS.claudeQaDefault };
  }
  return { runtime: null, model: null };
}
