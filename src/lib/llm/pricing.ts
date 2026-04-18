const TOKENS_PER_MILLION = 1_000_000;

export interface ModelPricingPerMillionUsd {
  input: number;
  output: number;
}

function normalizeModelLookup(model: string) {
  return model.trim().toLowerCase();
}

export function anthropicPricingForModel(model: string): ModelPricingPerMillionUsd | null {
  const normalizedModel = normalizeModelLookup(model);
  if (!normalizedModel) return null;
  if (normalizedModel.includes('claude-opus-4-7') || normalizedModel.includes('opus 4.7')) return { input: 5, output: 25 };
  if (normalizedModel.includes('claude-opus-4-6') || normalizedModel.includes('opus 4.6')) return { input: 15, output: 75 };
  if (normalizedModel.includes('claude-sonnet-4-6') || normalizedModel.includes('sonnet 4.6')) return { input: 3, output: 15 };
  if (
    normalizedModel.includes('claude-sonnet-4-5')
    || normalizedModel.includes('sonnet 4.5')
    || normalizedModel.includes('claude-sonnet-4')
    || normalizedModel.includes('sonnet 4')
  ) {
    return { input: 3, output: 15 };
  }
  if (
    normalizedModel.includes('claude-haiku-4-5')
    || normalizedModel.includes('haiku 4.5')
    || normalizedModel.includes('claude-haiku')
    || normalizedModel.includes('haiku')
  ) {
    return { input: 0.8, output: 4 };
  }
  return null;
}

export function estimateAnthropicInputCostUsd(model: string, tokens: number): number | null {
  const pricing = anthropicPricingForModel(model);
  if (!pricing || !Number.isFinite(tokens) || tokens <= 0) return null;
  return (tokens * pricing.input) / TOKENS_PER_MILLION;
}
