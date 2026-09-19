import { CODEX_MODEL_IDS, isCodexModelId, MODEL_IDS } from '@/lib/models';
import { isThinkingEffort, type ThinkingEffort } from '@/lib/orchestrator/thinking-effort';
import { isBrainRoutingMode, type BrainRoutingMode, type ClassAComposer } from './defaults-env';

export interface BrainRoutingDefaults {
  /** `auto` uses managed inference for entitled plans; CLI use needs an explicit opt-in. */
  brainRoutingMode: BrainRoutingMode;
}

export interface BrainDefaults extends BrainRoutingDefaults {
  brainCodexModel: string;
  brainCodexEffort: ThinkingEffort;
}

export const BRAIN_DEFAULTS: BrainDefaults = {
  brainRoutingMode: 'auto',
  brainCodexModel: MODEL_IDS.codexWorkerDefault,
  brainCodexEffort: 'xhigh',
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
  return result;
}

export function resolveBrainRoutingModeSettings(
  envValue: BrainRoutingMode | null,
  storedValue: BrainRoutingMode | undefined,
) {
  return {
    values: {
      brainRoutingMode: envValue ?? storedValue ?? BRAIN_DEFAULTS.brainRoutingMode,
    },
    sources: {
      brainRoutingMode: envValue !== null ? 'env' as const : storedValue !== undefined ? 'file' as const : 'default' as const,
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
  if (update.brainRoutingMode === undefined) return;
  if (!isBrainRoutingMode(update.brainRoutingMode)) {
    throw new Error('brainRoutingMode must be "auto" or "subscription".');
  }
  stored.brainRoutingMode = update.brainRoutingMode;
}
