import { RAW_MODEL_IDS } from '@/lib/models';

export const MOBILE_ASK_MODEL_IDS = [
  'auto',
  'claude-sonnet',
  'claude-haiku',
  'codex-terra-xhigh',
  'managed-free',
] as const;

export type MobileAskModelId = typeof MOBILE_ASK_MODEL_IDS[number];

export interface MobileAskReadiness {
  claude: boolean;
  codex: boolean;
}

export interface MobileAskModel {
  id: MobileAskModelId;
  label: string;
  detail: string;
  available: boolean;
}

export type MobileAskRoute =
  | {
    kind: 'claude';
    requestedModel: 'auto' | 'claude-sonnet' | 'claude-haiku';
    cliModel: string;
  }
  | {
    kind: 'codex';
    requestedModel: 'auto' | 'codex-terra-xhigh';
    cliModel: typeof RAW_MODEL_IDS.openAiGpt56Terra;
    reasoningEffort: 'xhigh';
  }
  | {
    kind: 'managed';
    requestedModel: MobileAskModelId;
    fallback: boolean;
  };

const MOBILE_ASK_MODEL_ID_SET = new Set<string>(MOBILE_ASK_MODEL_IDS);

const MODEL_COPY: Record<MobileAskModelId, Omit<MobileAskModel, 'id' | 'available'>> = {
  auto: {
    label: 'Auto',
    detail: 'Claude Sonnet 5, then Codex GPT-5.6 Terra xhigh, then managed free.',
  },
  'claude-sonnet': {
    label: 'Claude Sonnet 5',
    detail: 'Uses the signed-in Claude Code CLI on this desktop.',
  },
  'claude-haiku': {
    label: 'Claude Haiku 4.5',
    detail: 'Uses the signed-in Claude Code CLI on this desktop.',
  },
  'codex-terra-xhigh': {
    label: 'Codex GPT-5.6 Terra · xhigh',
    detail: 'Uses the signed-in Codex CLI on this desktop.',
  },
  'managed-free': {
    label: 'Managed free',
    detail: 'Uses the o8 managed free inference tier.',
  },
};

/**
 * The phone can only select one of the public model ids. Unknown values are
 * treated as Auto so arbitrary upstream or CLI model names never cross the
 * desktop trust boundary.
 */
export function normalizeMobileAskModelId(value: unknown): MobileAskModelId {
  return typeof value === 'string' && MOBILE_ASK_MODEL_ID_SET.has(value)
    ? value as MobileAskModelId
    : 'auto';
}

export function buildMobileAskModelCatalog(readiness: MobileAskReadiness): {
  models: MobileAskModel[];
  defaultModel: MobileAskModelId;
} {
  const availability: Record<MobileAskModelId, boolean> = {
    auto: true,
    'claude-sonnet': readiness.claude,
    'claude-haiku': readiness.claude,
    'codex-terra-xhigh': readiness.codex,
    'managed-free': true,
  };
  const defaultModel: MobileAskModelId = readiness.claude
    ? 'claude-sonnet'
    : readiness.codex
      ? 'codex-terra-xhigh'
      : 'managed-free';

  return {
    models: MOBILE_ASK_MODEL_IDS.map((id) => ({
      id,
      ...MODEL_COPY[id],
      available: availability[id],
    })),
    defaultModel,
  };
}

export function resolveMobileAskRoute(
  requestedValue: unknown,
  readiness: MobileAskReadiness,
): MobileAskRoute {
  const requestedModel = normalizeMobileAskModelId(requestedValue);

  if (requestedModel === 'managed-free') {
    return { kind: 'managed', requestedModel, fallback: false };
  }
  if (requestedModel === 'auto') {
    if (readiness.claude) {
      return {
        kind: 'claude',
        requestedModel,
        cliModel: RAW_MODEL_IDS.anthropicClaudeSonnet5,
      };
    }
    if (readiness.codex) {
      return {
        kind: 'codex',
        requestedModel,
        cliModel: RAW_MODEL_IDS.openAiGpt56Terra,
        reasoningEffort: 'xhigh',
      };
    }
    return { kind: 'managed', requestedModel, fallback: true };
  }
  if (requestedModel === 'claude-sonnet' || requestedModel === 'claude-haiku') {
    if (!readiness.claude) {
      return { kind: 'managed', requestedModel, fallback: true };
    }
    return {
      kind: 'claude',
      requestedModel,
      cliModel: requestedModel === 'claude-sonnet'
        ? RAW_MODEL_IDS.anthropicClaudeSonnet5
        : RAW_MODEL_IDS.anthropicClaudeHaiku45Dated,
    };
  }
  if (!readiness.codex) {
    return { kind: 'managed', requestedModel, fallback: true };
  }
  return {
    kind: 'codex',
    requestedModel,
    cliModel: RAW_MODEL_IDS.openAiGpt56Terra,
    reasoningEffort: 'xhigh',
  };
}
