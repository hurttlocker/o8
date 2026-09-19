import { CODEX_MODEL_IDS, isCodexModelId, MODEL_IDS } from '@/lib/models';
import { isThinkingEffort, type ThinkingEffort } from '@/lib/orchestrator/thinking-effort';
import { envBrainWarmupEnabled, isBrainRoutingMode, type BrainRoutingMode, type ClassAComposer } from './defaults-env';

export interface BrainRoutingDefaults {
  /** `auto` uses managed inference for entitled plans; CLI use needs an explicit opt-in. */
  brainRoutingMode: BrainRoutingMode;
}

export interface BrainDefaults extends BrainRoutingDefaults {
  brainCodexModel: string;
  brainCodexEffort: ThinkingEffort;
  /**
   * Speculative Brain runtime warmup (#2521). **On by default.** When on, the
   * ask pipeline (and the codex/fable orchestrator backends) pre-spawn the
   * selected Haiku/Sonnet CLI procs before an ask needs them so a warm proc
   * can serve the next explicit ask. Off disables only that speculative
   * pre-spawn: an explicit ask still launches its selected runtime when
   * needed (it may reuse an already-warm pool proc), and disabling can add
   * latency when a runtime has to start. A managed-only route never warms a
   * subscription runtime either way. Persisted, so it survives restart.
   * Env: `O8_BRAIN_WARMUP` (1/0).
   */
  brainWarmupEnabled: boolean;
}

export const BRAIN_DEFAULTS: BrainDefaults = {
  brainRoutingMode: 'auto',
  brainCodexModel: MODEL_IDS.codexWorkerDefault,
  brainCodexEffort: 'xhigh',
  brainWarmupEnabled: true,
};

type BrainRoutingStored = Partial<BrainDefaults> & {
  classAComposer?: ClassAComposer;
};

/** Preserve the old explicit Claude choices as opt-ins; a legacy Codex default is not one. */
export function resolveStoredBrainDefaults(stored: BrainRoutingStored): Partial<BrainDefaults> {
  const result: Partial<BrainDefaults> = {};
  if (typeof stored.brainCodexModel === 'string' && isCodexModelId(stored.brainCodexModel.trim())) {
    result.brainCodexModel = stored.brainCodexModel.trim();
  }
  if (stored.brainCodexEffort && isThinkingEffort(stored.brainCodexEffort)) {
    result.brainCodexEffort = stored.brainCodexEffort;
  }
  if (isBrainRoutingMode(stored.brainRoutingMode)) {
    result.brainRoutingMode = stored.brainRoutingMode;
  } else if (stored.classAComposer === 'haiku-cli' || stored.classAComposer === 'sonnet-cli') {
    result.brainRoutingMode = 'subscription';
  }
  if (typeof stored.brainWarmupEnabled === 'boolean') {
    result.brainWarmupEnabled = stored.brainWarmupEnabled;
  }
  return result;
}

export function resolveBrainRoutingModeSettings(
  envValue: BrainRoutingMode | null,
  storedValue: Partial<BrainDefaults>,
) {
  const envWarmup = envBrainWarmupEnabled();
  return {
    values: {
      brainRoutingMode: envValue ?? storedValue.brainRoutingMode ?? BRAIN_DEFAULTS.brainRoutingMode,
      brainWarmupEnabled: envWarmup ?? storedValue.brainWarmupEnabled ?? BRAIN_DEFAULTS.brainWarmupEnabled,
    },
    sources: {
      brainRoutingMode: envValue !== null ? 'env' as const : storedValue.brainRoutingMode !== undefined ? 'file' as const : 'default' as const,
      brainWarmupEnabled: envWarmup !== null ? 'env' as const : storedValue.brainWarmupEnabled !== undefined ? 'file' as const : 'default' as const,
    },
  };
}

export function applyBrainDefaultsUpdate(
  stored: Partial<BrainDefaults>,
  update: Partial<BrainDefaults>,
): void {
  if (update.brainCodexModel !== undefined) {
    const trimmed = update.brainCodexModel.trim();
    if (!isCodexModelId(trimmed)) {
      throw new Error(`brainCodexModel ${JSON.stringify(trimmed)} is unsupported; valid values are ${CODEX_MODEL_IDS.map((model) => JSON.stringify(model)).join(', ')}.`);
    }
    stored.brainCodexModel = trimmed;
  }
  if (update.brainCodexEffort !== undefined) {
    if (!isThinkingEffort(update.brainCodexEffort)) throw new Error('brainCodexEffort must be a valid ThinkingEffort value.');
    stored.brainCodexEffort = update.brainCodexEffort;
  }
  if (update.brainWarmupEnabled !== undefined) {
    if (typeof update.brainWarmupEnabled !== 'boolean') throw new Error('brainWarmupEnabled must be a boolean.');
    stored.brainWarmupEnabled = update.brainWarmupEnabled;
  }
  if (update.brainRoutingMode === undefined) return;
  if (!isBrainRoutingMode(update.brainRoutingMode)) {
    throw new Error('brainRoutingMode must be "auto" or "subscription".');
  }
  stored.brainRoutingMode = update.brainRoutingMode;
}
