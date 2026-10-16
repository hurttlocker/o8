/** Empty selects the agent default; absent leaves the caller's fallback in charge. */
export function normalizeOrchestratorTurnModel(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim() : undefined;
}

/** Fixed managed routing cannot inherit a model pin from another provider. */
export function resolveBackendTurnModel(backend: string | undefined, value: unknown): string | undefined {
  const model = normalizeOrchestratorTurnModel(value);
  return backend === 'o8' && !model?.startsWith('o8-') ? 'o8-free' : model;
}
