import { isOrchestratorServiceTier, type OrchestratorServiceTier } from '@/lib/orchestrator/service-tier';

const KEY = 'o8:composer-service-tiers:v1';
export const COMPOSER_SERVICE_TIER_EVENT = 'o8:composer-service-tier-changed';
function preferenceKey(backend: string, model: string) { return `${backend}:${model}`; }
export function readComposerServiceTier(backend: string, model: string): OrchestratorServiceTier | undefined {
  if (typeof window === 'undefined') return undefined;
  try { const value = JSON.parse(localStorage.getItem(KEY) ?? '{}')[preferenceKey(backend, model)]; return isOrchestratorServiceTier(value) ? value : undefined; } catch { return undefined; }
}
/** User-selected speeds never rewrite the CLI's own configuration or auth. */
export function writeComposerServiceTier(backend: string, model: string, tier: OrchestratorServiceTier): boolean {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    const previous = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    localStorage.setItem(KEY, JSON.stringify({ ...previous, [preferenceKey(backend, model)]: tier }));
    window.dispatchEvent(new Event(COMPOSER_SERVICE_TIER_EVENT));
    return true;
  } catch { return false; }
}
