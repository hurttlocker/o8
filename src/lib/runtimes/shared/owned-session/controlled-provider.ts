/** A deliberately bounded carrier for held, read-only, single-attempt tasks. */
export const CONTROLLED_OPENROUTER_MODEL = 'deepseek/deepseek-v4.1-flash';
export const CONTROLLED_OPENROUTER_POLICY = {
  carrier: 'openrouter', reasoning: 'provider-default', maxRequests: 4,
  maxOutputTokens: 2048, maxRequestBytes: 64_000, costUsd: 0.01,
} as const;
export type ControlledOpenRouterPolicy = typeof CONTROLLED_OPENROUTER_POLICY;

export function parseControlledProvider(value: unknown): ControlledOpenRouterPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== Object.keys(CONTROLLED_OPENROUTER_POLICY).length
    || Object.entries(CONTROLLED_OPENROUTER_POLICY).some(([key, expected]) =>
      (value as Record<string, unknown>)[key] !== expected)) {
    throw new Error('Controlled provider limits must match the offered read-only route.');
  }
  return { ...CONTROLLED_OPENROUTER_POLICY };
}

export function controlledProviderConfig(provider?: ControlledOpenRouterPolicy): Record<string, string> {
  return provider ? { modelSource: 'openrouter', controlledProvider: JSON.stringify(parseControlledProvider(provider)) } : {};
}

export function providerFromConfig(config?: Record<string, string>): ControlledOpenRouterPolicy | undefined {
  if (config?.controlledProvider === undefined) return undefined;
  if (config.modelSource !== 'openrouter') throw new Error('Controlled provider carrier changed.');
  return parseControlledProvider(JSON.parse(config.controlledProvider));
}

export function controlledProviderPins(model: string | undefined, effort: unknown,
  config?: Record<string, string>): boolean {
  return !!providerFromConfig(config) && model === CONTROLLED_OPENROUTER_MODEL
    && effort === undefined && config?.workMode === 'read-only' && config.executionCarrier === undefined;
}
