/** Empty selects the agent default; absent leaves the caller's fallback in charge. */
export function normalizeOrchestratorTurnModel(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim() : undefined;
}
