export interface ModelRate {
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  cacheReadUsdPerMillion?: number;
  cacheWriteUsdPerMillion?: number;
  cacheWrite1hUsdPerMillion?: number;
}

export interface ModelRateTable {
  rateTableVersion: string;
  observedOn: `${number}-${number}-${number}`;
  rates: Record<string, ModelRate>;
}

/**
 * The first dated snapshot centralizes the exact values that were already
 * checked into the runtime parsers and Brain spend guard. `observedOn` is the
 * consolidation date, not a claim that provider prices were refreshed.
 */
export const modelRateTable = {
  rateTableVersion: '2026-08-28.1',
  observedOn: '2026-08-28',
  rates: {
    'claude-opus-4-8': {
      inputUsdPerMillion: 5,
      outputUsdPerMillion: 25,
      cacheReadUsdPerMillion: 0.5,
      cacheWriteUsdPerMillion: 6.25,
      cacheWrite1hUsdPerMillion: 10,
    },
    'claude-opus-4-8-fast': {
      inputUsdPerMillion: 30,
      outputUsdPerMillion: 150,
      cacheReadUsdPerMillion: 3,
      cacheWriteUsdPerMillion: 37.5,
      cacheWrite1hUsdPerMillion: 60,
    },
    'claude-opus-4-7': {
      inputUsdPerMillion: 5,
      outputUsdPerMillion: 25,
      cacheReadUsdPerMillion: 0.5,
      cacheWriteUsdPerMillion: 6.25,
      cacheWrite1hUsdPerMillion: 10,
    },
    'claude-opus-4-7-fast': {
      inputUsdPerMillion: 30,
      outputUsdPerMillion: 150,
      cacheReadUsdPerMillion: 3,
      cacheWriteUsdPerMillion: 37.5,
      cacheWrite1hUsdPerMillion: 60,
    },
    'claude-opus-4-6': {
      inputUsdPerMillion: 5,
      outputUsdPerMillion: 25,
      cacheReadUsdPerMillion: 0.5,
      cacheWriteUsdPerMillion: 6.25,
      cacheWrite1hUsdPerMillion: 10,
    },
    'claude-opus-4-6-fast': {
      inputUsdPerMillion: 30,
      outputUsdPerMillion: 150,
      cacheReadUsdPerMillion: 3,
      cacheWriteUsdPerMillion: 37.5,
      cacheWrite1hUsdPerMillion: 60,
    },
    'claude-sonnet-5': {
      inputUsdPerMillion: 3,
      outputUsdPerMillion: 15,
      cacheReadUsdPerMillion: 0.3,
      cacheWriteUsdPerMillion: 3.75,
      cacheWrite1hUsdPerMillion: 6,
    },
    'claude-sonnet-4-6': {
      inputUsdPerMillion: 3,
      outputUsdPerMillion: 15,
      cacheReadUsdPerMillion: 0.3,
      cacheWriteUsdPerMillion: 3.75,
      cacheWrite1hUsdPerMillion: 6,
    },
    'claude-sonnet-4-5': {
      inputUsdPerMillion: 3,
      outputUsdPerMillion: 15,
      cacheReadUsdPerMillion: 0.3,
      cacheWriteUsdPerMillion: 3.75,
      cacheWrite1hUsdPerMillion: 6,
    },
    'claude-haiku-4-5': {
      inputUsdPerMillion: 0.8,
      outputUsdPerMillion: 4,
      cacheReadUsdPerMillion: 0.08,
      cacheWriteUsdPerMillion: 1,
      cacheWrite1hUsdPerMillion: 1.6,
    },
    'gpt-5.6-sol': {
      inputUsdPerMillion: 5,
      outputUsdPerMillion: 30,
      cacheReadUsdPerMillion: 0.5,
    },
    'gpt-5.6-terra': {
      inputUsdPerMillion: 2.5,
      outputUsdPerMillion: 15,
      cacheReadUsdPerMillion: 0.25,
    },
    'gpt-5.6-luna': {
      inputUsdPerMillion: 1,
      outputUsdPerMillion: 6,
      cacheReadUsdPerMillion: 0.1,
    },
    'gpt-5.5': {
      inputUsdPerMillion: 2.5,
      outputUsdPerMillion: 15,
      cacheReadUsdPerMillion: 0.25,
    },
    'gpt-5.4-mini': {
      inputUsdPerMillion: 0.75,
      outputUsdPerMillion: 4.5,
      cacheReadUsdPerMillion: 0.075,
    },
    'gpt-5.4-nano': {
      inputUsdPerMillion: 0.2,
      outputUsdPerMillion: 1.25,
      cacheReadUsdPerMillion: 0.02,
    },
    'gpt-5.4': {
      inputUsdPerMillion: 2.5,
      outputUsdPerMillion: 15,
      cacheReadUsdPerMillion: 0.25,
    },
    'gpt-5.2-pro': {
      inputUsdPerMillion: 21,
      outputUsdPerMillion: 168,
      cacheReadUsdPerMillion: 2.1,
    },
    'gpt-5.2-codex': {
      inputUsdPerMillion: 1.5,
      outputUsdPerMillion: 6,
      cacheReadUsdPerMillion: 0.15,
    },
    'gpt-5.2': {
      inputUsdPerMillion: 2,
      outputUsdPerMillion: 8,
      cacheReadUsdPerMillion: 0.2,
    },
    'gemini-3-pro': {
      inputUsdPerMillion: 1.25,
      outputUsdPerMillion: 10,
      cacheReadUsdPerMillion: 0.3125,
    },
    'gemini-2-5-pro': {
      inputUsdPerMillion: 1.25,
      outputUsdPerMillion: 10,
      cacheReadUsdPerMillion: 0.3125,
    },
    'gemini-2-5-flash': {
      inputUsdPerMillion: 0.075,
      outputUsdPerMillion: 0.30,
      cacheReadUsdPerMillion: 0.019,
    },
    'gemini-1-5-flash': {
      inputUsdPerMillion: 0.075,
      outputUsdPerMillion: 0.30,
      cacheReadUsdPerMillion: 0.019,
    },
    'cursor-agent': {
      inputUsdPerMillion: 1.25,
      outputUsdPerMillion: 10,
      cacheWriteUsdPerMillion: 1.25,
    },
    'opencode/gpt-5-nano': { inputUsdPerMillion: 0.05, outputUsdPerMillion: 0.20 },
    'opencode/gpt-5-mini': { inputUsdPerMillion: 0.15, outputUsdPerMillion: 0.60 },
    'opencode/gpt-5': { inputUsdPerMillion: 1.0, outputUsdPerMillion: 4.0 },
    'anthropic/claude-sonnet-4-20250514': { inputUsdPerMillion: 3, outputUsdPerMillion: 15 },
    'anthropic/claude-haiku-4-20250514': { inputUsdPerMillion: 0.8, outputUsdPerMillion: 4 },
    'anthropic/claude-opus-4-20250514': { inputUsdPerMillion: 15, outputUsdPerMillion: 75 },
    'google/gemini-2.5-pro': { inputUsdPerMillion: 1.25, outputUsdPerMillion: 10 },
    'google/gemini-2.5-flash': { inputUsdPerMillion: 0.075, outputUsdPerMillion: 0.30 },
    'openai/gpt-4o': { inputUsdPerMillion: 2.5, outputUsdPerMillion: 10 },
    'openai/gpt-4o-mini': { inputUsdPerMillion: 0.15, outputUsdPerMillion: 0.60 },
    'openai/gpt-5-nano': { inputUsdPerMillion: 0.05, outputUsdPerMillion: 0.20 },
    'openrouter/anthropic/claude-haiku': { inputUsdPerMillion: 0.8, outputUsdPerMillion: 4 },
    'openrouter/anthropic/claude-sonnet': { inputUsdPerMillion: 3, outputUsdPerMillion: 15 },
    'brain/google/gemini-2.5-flash-lite': { inputUsdPerMillion: 0.10, outputUsdPerMillion: 0.40 },
    'brain/openai/gpt-5.4-nano': { inputUsdPerMillion: 0.20, outputUsdPerMillion: 1.25 },
    'brain/x-ai/grok-4.3': { inputUsdPerMillion: 1.25, outputUsdPerMillion: 2.50 },
  },
} as const satisfies ModelRateTable;

export type ResolvedRate = ModelRate & { modelKey: string };

function resolved(modelKey: keyof typeof modelRateTable.rates): ResolvedRate {
  return { modelKey, ...modelRateTable.rates[modelKey] };
}

function resolveAnthropicRate(model: string): ResolvedRate | null {
  const normalized = model.trim().toLowerCase();
  if (!normalized || normalized === '<synthetic>') return null;
  const fast = normalized.includes('fast');
  if (normalized.includes('opus-4-8')) return resolved(fast ? 'claude-opus-4-8-fast' : 'claude-opus-4-8');
  if (normalized.includes('opus-4-7')) return resolved(fast ? 'claude-opus-4-7-fast' : 'claude-opus-4-7');
  if (normalized.includes('opus-4-6')) return resolved(fast ? 'claude-opus-4-6-fast' : 'claude-opus-4-6');
  if (normalized.includes('sonnet-5')) return resolved('claude-sonnet-5');
  if (normalized.includes('sonnet-4-6')) return resolved('claude-sonnet-4-6');
  if (normalized.includes('sonnet-4-5') || normalized.includes('sonnet-4')) return resolved('claude-sonnet-4-5');
  if (normalized.includes('haiku-4-5') || normalized.includes('haiku')) return resolved('claude-haiku-4-5');
  return null;
}

function resolveCodexRate(model: string): ResolvedRate | null {
  const normalized = model.trim().toLowerCase();
  if (normalized.includes('gpt-5.6-sol')) return resolved('gpt-5.6-sol');
  if (normalized.includes('gpt-5.6-terra')) return resolved('gpt-5.6-terra');
  if (normalized.includes('gpt-5.6-luna')) return resolved('gpt-5.6-luna');
  if (normalized.includes('gpt-5.5')) return resolved('gpt-5.5');
  if (normalized.includes('gpt-5.4-mini')) return resolved('gpt-5.4-mini');
  if (normalized.includes('gpt-5.4-nano')) return resolved('gpt-5.4-nano');
  if (normalized.includes('gpt-5.4')) return resolved('gpt-5.4');
  if (normalized.includes('gpt-5.2-pro')) return resolved('gpt-5.2-pro');
  if (normalized.includes('gpt-5.2-codex')) return resolved('gpt-5.2-codex');
  if (normalized.includes('gpt-5.2')) return resolved('gpt-5.2');
  return null;
}

function resolveGeminiRate(model: string): ResolvedRate {
  const normalized = model.trim().toLowerCase();
  if (/gemini-3(?:[.-]\d+)?-pro/i.test(normalized)) return resolved('gemini-3-pro');
  if (/gemini-2[.-]5-pro/i.test(normalized)) return resolved('gemini-2-5-pro');
  if (/gemini-2[.-]5-flash/i.test(normalized)) return resolved('gemini-2-5-flash');
  if (/gemini-1[.-]5-flash/i.test(normalized)) return resolved('gemini-1-5-flash');
  // This parser intentionally falls back to the pessimistic Pro rate.
  return resolved('gemini-3-pro');
}

function resolveOpenCodeRate(model: string): ResolvedRate | null {
  if (!Object.hasOwn(modelRateTable.rates, model) || model.startsWith('brain/')) return null;
  const allowed = new Set([
    'opencode/gpt-5-nano',
    'opencode/gpt-5-mini',
    'opencode/gpt-5',
    'anthropic/claude-sonnet-4-20250514',
    'anthropic/claude-haiku-4-20250514',
    'anthropic/claude-opus-4-20250514',
    'google/gemini-2.5-pro',
    'google/gemini-2.5-flash',
    'openai/gpt-4o',
    'openai/gpt-4o-mini',
    'openai/gpt-5-nano',
    'openrouter/anthropic/claude-haiku',
    'openrouter/anthropic/claude-sonnet',
  ]);
  return allowed.has(model) ? resolved(model as keyof typeof modelRateTable.rates) : null;
}

function resolveBrainRate(model: string): ResolvedRate {
  const key = `brain/${model}`;
  if (Object.hasOwn(modelRateTable.rates, key)) {
    return resolved(key as keyof typeof modelRateTable.rates);
  }
  // The Brain intentionally falls back to the priciest seeded chain entry.
  return resolved('brain/x-ai/grok-4.3');
}

/**
 * Provider-specific lookup preserves each former parser fallback:
 * Claude/Codex/OpenCode return null for unknown models, Gemini uses Pro,
 * Cursor always uses its fixed estimate, and the Brain uses its worst case.
 */
export function resolveRate(provider: string, model: string | null | undefined): ResolvedRate | null {
  const normalizedProvider = provider.trim().toLowerCase();
  const normalizedModel = model ?? '';
  if (normalizedProvider === 'anthropic' || normalizedProvider === 'claude-code') {
    return resolveAnthropicRate(normalizedModel);
  }
  if (normalizedProvider === 'openai' || normalizedProvider === 'codex') {
    return resolveCodexRate(normalizedModel);
  }
  if (normalizedProvider === 'google' || normalizedProvider === 'gemini') {
    return resolveGeminiRate(normalizedModel);
  }
  if (normalizedProvider === 'cursor') return resolved('cursor-agent');
  if (normalizedProvider === 'opencode') return resolveOpenCodeRate(normalizedModel);
  if (normalizedProvider === 'brain' || normalizedProvider === 'openrouter') return resolveBrainRate(normalizedModel);
  return null;
}
