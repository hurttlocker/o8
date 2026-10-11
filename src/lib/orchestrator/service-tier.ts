export type OrchestratorServiceTier = 'default' | 'fast' | 'priority' | 'ultrafast';
export interface ServiceTierOption { id: OrchestratorServiceTier; label: string; description?: string }
export const STANDARD_SERVICE_TIER: ServiceTierOption = { id: 'default', label: 'Standard' };
export function isOrchestratorServiceTier(value: unknown): value is OrchestratorServiceTier {
  return value === 'default' || value === 'fast' || value === 'priority' || value === 'ultrafast';
}
export function claudeModelSupportsFast(model: string): boolean {
  return /^(?:anthropic\/)?claude-opus-(?:5-5|5|4-8)(?:-\d{8})?$/.test(model);
}
export function codexServiceTierOptions(model: { serviceTiers?: unknown; additionalSpeedTiers?: unknown }): ServiceTierOption[] {
  const tiers = Array.isArray(model.serviceTiers) && model.serviceTiers.length > 0 ? model.serviceTiers : Array.isArray(model.additionalSpeedTiers) ? model.additionalSpeedTiers.map((id) => ({ id })) : [];
  const seen = new Set<string>(['default']);
  return [STANDARD_SERVICE_TIER, ...tiers.flatMap((tier): ServiceTierOption[] => {
    if (!tier || !isOrchestratorServiceTier(tier.id) || seen.has(tier.id)) return [];
    seen.add(tier.id);
    return [{ id: tier.id, label: tier.id === 'ultrafast' ? 'Ultra-fast' : 'Fast', description: typeof tier.description === 'string' ? tier.description.slice(0,240) : undefined }];
  })];
}

/** An explicit speed belongs to its selected backend/model, including quota retries. */
export function serviceTierForTurn(tier: OrchestratorServiceTier | undefined, sourceBackend: string, sourceModel: string | undefined, backend: string, model: string | undefined): OrchestratorServiceTier | undefined {
  if (tier === undefined) return undefined;
  return sourceBackend === backend && sourceModel === model ? tier : 'default';
}
