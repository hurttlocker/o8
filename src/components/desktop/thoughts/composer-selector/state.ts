import { COMPOSER_MODE_DIRECTIVES } from '@/lib/orchestrator/composer-wire';
import { isCodexUltraCapableModel } from '@/lib/codex/reasoning-effort';
import {
  isThinkingEffort,
  type ThinkingEffort,
} from '@/lib/orchestrator/thinking-effort';
import { parseLocalModel } from '@/lib/codex/local-model';
import { MODEL_IDS } from '@/lib/models';
import type { OrchestratorRuntime } from '@/lib/orchestrator/runtime-capabilities';
import type { OrchestratorBackendSetting } from '../operator-defaults';

export const COMPOSER_SELECTOR_V1_STORAGE_KEY = 'o8:composer-selector-v1';
export const COMPOSER_EFFORT_BY_MODEL_STORAGE_KEY = 'o8:orchestrator:thinking-effort-by-model';
export const COMPOSER_EFFORT_MIGRATION_STORAGE_KEY = `${COMPOSER_EFFORT_BY_MODEL_STORAGE_KEY}:migrated`;
export const LEGACY_COMPOSER_EFFORT_STORAGE_KEY = 'o8:orchestrator:thinking-effort';

export type ComposerSelectorMode = 'solo' | 'multitask' | 'moa' | 'fusion';
export type ComposerEffortMap = Partial<Record<string, ThinkingEffort>>;
export type ComposerProviderMark = 'anthropic' | 'openai' | 'gemini' | 'x' | 'deepseek' | 'copilot' | 'ollama' | 'o8' | 'terminal';

export const COMPOSER_PROVIDER_MARK_TABLE = {
  leadModelFamilies: [
    { pattern: /^ollama:/i, mark: 'ollama' },
    { pattern: /deepseek/i, mark: 'deepseek' },
    { pattern: /(?:^|\/)gemini|google\//i, mark: 'gemini' },
    { pattern: /(?:^|\/)grok|x-ai\//i, mark: 'x' },
    { pattern: /(?:^|\/)claude|anthropic\//i, mark: 'anthropic' },
    { pattern: /(?:^|\/)gpt-|openai\//i, mark: 'openai' },
  ],
  leadBackends: {
    auto: 'terminal',
    codex: 'openai',
    claude: 'anthropic',
    openclaw: 'terminal',
    hermes: 'terminal',
    collide: 'terminal',
    fable: 'anthropic',
    o8: 'o8',
    opencode: 'terminal',
  },
  workerRuntimes: {
    codex: 'openai',
    'claude-code': 'anthropic',
    gemini: 'gemini',
    antigravity: 'gemini',
    magnitude: 'terminal',
    opencode: 'terminal',
    'copilot-cli': 'copilot',
    crush: 'terminal',
    openhands: 'terminal',
    goose: 'terminal',
    qwen: 'terminal',
    qoder: 'terminal',
    kimi: 'terminal',
    aider: 'terminal',
    '3code': 'terminal',
    pi: 'terminal',
    cursor: 'terminal',
    grok: 'x',
    'prime-agent': 'terminal',
    'deepseek-harness': 'deepseek',
  },
} as const satisfies {
  leadModelFamilies: readonly { pattern: RegExp; mark: ComposerProviderMark }[];
  leadBackends: Record<OrchestratorBackendSetting, ComposerProviderMark>;
  workerRuntimes: Record<OrchestratorRuntime, ComposerProviderMark>;
};

export const COMPOSER_EFFORT_CONSEQUENCES: Record<ThinkingEffort, string> = {
  low: 'Low · fast, cheapest',
  medium: 'Medium · balanced',
  adaptive: 'Adaptive · the model picks',
  high: 'High · default for real work',
  xhigh: 'Extra · longer turns',
  max: 'Max · usage limits apply',
  ultra: 'Ultra · longest turns, usage limits apply',
};

export function providerMarkForLead(
  backend: OrchestratorBackendSetting,
  modelId: string,
): ComposerProviderMark {
  return COMPOSER_PROVIDER_MARK_TABLE.leadModelFamilies
    .find(({ pattern }) => pattern.test(modelId))?.mark
    ?? COMPOSER_PROVIDER_MARK_TABLE.leadBackends[backend];
}

export function providerMarkForRuntime(runtime: OrchestratorRuntime): ComposerProviderMark {
  return COMPOSER_PROVIDER_MARK_TABLE.workerRuntimes[runtime];
}

export function composerEffortConsequence(
  backend: OrchestratorBackendSetting,
  effort: ThinkingEffort,
): string {
  if (backend === 'o8') return effort === 'high' ? 'High · founders' : 'Low · free';
  return COMPOSER_EFFORT_CONSEQUENCES[effort];
}

export function isTopComposerEffort(
  effort: ThinkingEffort,
  options: readonly ThinkingEffort[],
): boolean {
  return options.length > 2 && (effort === 'xhigh' || effort === 'max' || effort === 'ultra');
}

export interface ComposerSelectorModeSpec {
  id: ComposerSelectorMode;
  label: string;
  chip: string;
  sublabel: string;
  placeholder: string;
  directive: string;
}

export const COMPOSER_SELECTOR_MODES: readonly ComposerSelectorModeSpec[] = [
  {
    id: 'solo',
    label: 'Solo',
    chip: 'Solo',
    sublabel: 'Works alone, nothing is dispatched',
    placeholder: 'Build solo, no dispatches · / for commands',
    directive: COMPOSER_MODE_DIRECTIVES.solo,
  },
  {
    id: 'multitask',
    label: 'Multitask',
    chip: 'Multitask',
    sublabel: 'Parallel packets in isolated worktrees',
    placeholder: 'Parallel packets in isolated worktrees…',
    directive: COMPOSER_MODE_DIRECTIVES.multitask,
  },
  {
    id: 'moa',
    label: 'Compare plans',
    chip: 'Compare plans',
    sublabel: 'Two independent plans, then synthesis and workers',
    placeholder: 'Two independent plans, then synthesis and workers…',
    directive: COMPOSER_MODE_DIRECTIVES.moa,
  },
  {
    id: 'fusion',
    label: 'Fusion',
    chip: 'Fusion',
    sublabel: 'Sub-agents and every runtime’s workers, in parallel',
    placeholder: 'Sub-agents and every runtime’s workers, in parallel…',
    directive: COMPOSER_MODE_DIRECTIVES.fusion,
  },
];

const BASE_EFFORTS: readonly ThinkingEffort[] = ['low', 'medium', 'adaptive', 'high', 'xhigh', 'max'];
const EFFORT_RANK: Record<ThinkingEffort, number> = {
  low: 0,
  medium: 1,
  adaptive: 2,
  high: 3,
  xhigh: 4,
  max: 5,
  ultra: 6,
};

export interface ResolveComposerSelectorInput {
  mode: ComposerSelectorMode;
  leadModelId: string;
  leadModelLabel: string;
  leadBackend: OrchestratorBackendSetting;
  inSessionEffortByModel: ComposerEffortMap;
  threadEffortByModel: ComposerEffortMap;
  operatorDefaultEffort: ThinkingEffort;
  adaptiveEnabled: boolean;
  isFreePlan?: boolean;
  workerRuntimeLabel: string;
  workerModelLabel?: string | null;
  clampNotice?: ComposerEffortClampNotice | null;
}

export interface ComposerEffortClampNotice {
  modelId: string;
  from: ThinkingEffort;
}

export interface ComposerLeadCatalogueOption {
  backend: OrchestratorBackendSetting;
  model?: string;
  value: string;
  label: string;
}

export interface ResolvedComposerSelectorState {
  mode: ComposerSelectorMode;
  modeLabel: string;
  modeSublabel: string;
  modeDirective: string;
  orchestrationMode: 'single' | 'fleet' | 'fusion';
  effort: ThinkingEffort;
  effortClampedFrom: ThinkingEffort | null;
  effortOptions: readonly ThinkingEffort[];
  leadModelId: string;
  leadModelLabel: string;
  leadBackend: OrchestratorBackendSetting;
  workerRuntimeLabel: string;
  workerModelLabel: string | null;
  atRestText: string;
  chipTitle: string;
}

export function readComposerSelectorV1Flag(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(COMPOSER_SELECTOR_V1_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function resolveEffectiveComposerLeadModelId(
  backend: OrchestratorBackendSetting | undefined,
  modelId: string | undefined,
  defaultDispatchModel?: string,
): string | undefined {
  const configuredModel = modelId?.trim();
  if (backend === 'codex') {
    if (configuredModel && !/^claude/i.test(configuredModel)) return configuredModel;
    const dispatchModel = defaultDispatchModel?.trim();
    return dispatchModel && parseLocalModel(dispatchModel) ? dispatchModel : MODEL_IDS.codexDefault;
  }
  return configuredModel || undefined;
}

export function resolveComposerLeadCatalogueLabel(
  backend: OrchestratorBackendSetting,
  modelId: string,
  fallbackLabel: string,
  options: readonly ComposerLeadCatalogueOption[],
): string {
  return options.find((option) => (
    option.backend === backend && (option.model ?? option.value) === modelId
  ))?.label ?? fallbackLabel;
}

export function composerSelectorModeSpec(mode: ComposerSelectorMode): ComposerSelectorModeSpec {
  return COMPOSER_SELECTOR_MODES.find((entry) => entry.id === mode) ?? COMPOSER_SELECTOR_MODES[0];
}

export function cycleComposerSelectorMode(mode: ComposerSelectorMode, direction = 1): ComposerSelectorMode {
  const index = Math.max(0, COMPOSER_SELECTOR_MODES.findIndex((entry) => entry.id === mode));
  return COMPOSER_SELECTOR_MODES[
    (index + direction + COMPOSER_SELECTOR_MODES.length) % COMPOSER_SELECTOR_MODES.length
  ].id;
}

export function resolveComposerSelectorExecutionMode(mode: ComposerSelectorMode): 'single' | 'fleet' | 'fusion' {
  if (mode === 'solo') return 'single';
  if (mode === 'fusion') return 'fusion';
  return 'fleet';
}

export function supportedEffortsForLead(
  backend: OrchestratorBackendSetting,
  modelId: string,
  adaptiveEnabled: boolean,
  _isFreePlan = false,
): readonly ThinkingEffort[] {
  if (backend === 'o8') return ['low', 'high'];
  if (backend !== 'claude' && backend !== 'fable' && backend !== 'codex' && backend !== 'auto') return [];
  const base = adaptiveEnabled ? [...BASE_EFFORTS] : BASE_EFFORTS.filter((effort) => effort !== 'adaptive');
  const ultraCapable = backend === 'codex' && isCodexUltraCapableModel(modelId);
  if (backend === 'codex') return ultraCapable ? [...base, 'ultra'] : base.filter((effort) => effort !== 'max');
  return base;
}

export function clampEffortToLead(
  effort: ThinkingEffort,
  options: readonly ThinkingEffort[],
): { effort: ThinkingEffort; clampedFrom: ThinkingEffort | null } {
  if (options.length === 0 || options.includes(effort)) return { effort, clampedFrom: null };
  const fallback = [...options].sort((left, right) => {
    const leftDistance = Math.abs(EFFORT_RANK[left] - EFFORT_RANK[effort]);
    const rightDistance = Math.abs(EFFORT_RANK[right] - EFFORT_RANK[effort]);
    return leftDistance - rightDistance || EFFORT_RANK[right] - EFFORT_RANK[left];
  })[0];
  return { effort: fallback, clampedFrom: effort };
}

export function setModelEffort(
  efforts: ComposerEffortMap,
  modelId: string,
  effort: ThinkingEffort,
): ComposerEffortMap {
  return { ...efforts, [modelId]: effort };
}

export function resolveComposerSelectorState(input: ResolveComposerSelectorInput): ResolvedComposerSelectorState {
  const storedEffort = input.inSessionEffortByModel[input.leadModelId]
    ?? input.threadEffortByModel[input.leadModelId];
  const requestedEffort = input.leadBackend === 'o8'
    ? input.isFreePlan ? 'low' : storedEffort ?? 'high'
    : storedEffort ?? input.operatorDefaultEffort;
  const effortOptions = supportedEffortsForLead(
    input.leadBackend,
    input.leadModelId,
    input.adaptiveEnabled,
    input.isFreePlan,
  );
  const clamped = clampEffortToLead(requestedEffort, effortOptions);
  const effort = clamped.effort;
  const clampedFrom = clamped.clampedFrom
    ?? (input.clampNotice?.modelId === input.leadModelId ? input.clampNotice.from : null);
  const mode = composerSelectorModeSpec(input.mode);
  const workerModelLabel = input.workerModelLabel?.trim() || null;
  const workerTail = workerModelLabel
    ? `${input.workerRuntimeLabel} · ${workerModelLabel}`
    : input.workerRuntimeLabel;
  const atRestText = `${input.leadModelLabel} · ${effort} / workers ${workerTail}`;
  return {
    mode: mode.id,
    modeLabel: mode.label,
    modeSublabel: mode.sublabel,
    modeDirective: mode.directive,
    orchestrationMode: resolveComposerSelectorExecutionMode(mode.id),
    effort,
    effortClampedFrom: clampedFrom,
    effortOptions,
    leadModelId: input.leadModelId,
    leadModelLabel: input.leadModelLabel,
    leadBackend: input.leadBackend,
    workerRuntimeLabel: input.workerRuntimeLabel,
    workerModelLabel,
    atRestText,
    chipTitle: clampedFrom
      ? `${atRestText}. ${clampedFrom} is unsupported for ${input.leadModelLabel}; clamped to ${effort}.`
      : atRestText,
  };
}

function threadEffortStorageKey(threadId: string): string {
  return `${COMPOSER_EFFORT_BY_MODEL_STORAGE_KEY}:thread:${threadId}`;
}

function readEffortMapAtKey(key: string): ComposerEffortMap {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, ThinkingEffort] => (
      Boolean(entry[0]) && isThinkingEffort(entry[1])
    )));
  } catch {
    return {};
  }
}

function writeEffortMapAtKey(key: string, efforts: ComposerEffortMap): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, JSON.stringify(efforts));
  } catch {
    // Storage is an optional preference seam; in-session state stays authoritative.
  }
}

export function readComposerEffortMaps(threadId: string | null, currentModelId: string): {
  global: ComposerEffortMap;
  thread: ComposerEffortMap;
} {
  const global = readEffortMapAtKey(COMPOSER_EFFORT_BY_MODEL_STORAGE_KEY);
  if (!global[currentModelId] && typeof window !== 'undefined') {
    try {
      const migrated = window.localStorage.getItem(COMPOSER_EFFORT_MIGRATION_STORAGE_KEY) === '1';
      if (!migrated) {
        const legacy = window.localStorage.getItem(LEGACY_COMPOSER_EFFORT_STORAGE_KEY);
        if (isThinkingEffort(legacy)) {
          global[currentModelId] = legacy;
          writeEffortMapAtKey(COMPOSER_EFFORT_BY_MODEL_STORAGE_KEY, global);
        }
        window.localStorage.setItem(COMPOSER_EFFORT_MIGRATION_STORAGE_KEY, '1');
      }
    } catch {
      // Ignore an unavailable migration source.
    }
  }
  return {
    global,
    thread: threadId ? readEffortMapAtKey(threadEffortStorageKey(threadId)) : {},
  };
}

export function writeComposerModelEffort(
  modelId: string,
  effort: ThinkingEffort,
  threadId: string | null,
): void {
  const global = setModelEffort(readEffortMapAtKey(COMPOSER_EFFORT_BY_MODEL_STORAGE_KEY), modelId, effort);
  writeEffortMapAtKey(COMPOSER_EFFORT_BY_MODEL_STORAGE_KEY, global);
  if (threadId) {
    const key = threadEffortStorageKey(threadId);
    writeEffortMapAtKey(key, setModelEffort(readEffortMapAtKey(key), modelId, effort));
  }
}

export function isComposerEffortShortcut(event: Pick<KeyboardEvent, 'altKey' | 'code' | 'key'>): boolean {
  return event.altKey && (event.code === 'KeyT' || event.key === 't' || event.key === 'T' || event.key === '†');
}

export function stepComposerEffort(
  current: ThinkingEffort,
  options: readonly ThinkingEffort[],
  direction: 1 | -1,
): ThinkingEffort {
  if (options.length === 0) return current;
  const index = Math.max(0, options.indexOf(current));
  return options[Math.max(0, Math.min(options.length - 1, index + direction))];
}
