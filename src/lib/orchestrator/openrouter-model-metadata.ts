import 'server-only';

import type { CatalogueModelMetadata } from './acp-model-catalogue';

export type OpenRouterModelSort = 'most-popular' | 'newest';

interface OpenRouterModelResponse {
  data?: Array<{
    id?: unknown;
    name?: unknown;
    created?: unknown;
    context_length?: unknown;
    description?: unknown;
    pricing?: { prompt?: unknown; completion?: unknown; request?: unknown } | null;
    architecture?: { output_modalities?: unknown } | null;
  }>;
}

interface CachedMetadata {
  expiresAt: number;
  metadata: ReadonlyMap<string, CatalogueModelMetadata>;
}

const CACHE_TTL_MS = 15 * 60 * 1000;
const cache = new Map<OpenRouterModelSort, CachedMetadata>();

function pricePerMillion(value: unknown): number | undefined {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined;
  if (typeof value === 'string' && !value.trim()) return undefined;
  const price = Number(value);
  return Number.isFinite(price) && price >= 0 ? price * 1_000_000 : undefined;
}

function knownZero(value: unknown): boolean {
  if (typeof value === 'number') return value === 0;
  return typeof value === 'string' && value.trim() !== '' && Number(value) === 0;
}

function freeFromPricing(id: string, pricing: NonNullable<OpenRouterModelResponse['data']>[number]['pricing']): boolean | undefined {
  if (!id.endsWith(':free') || !pricing || !knownZero(pricing.prompt) || !knownZero(pricing.completion)) return undefined;
  if (pricing.request === undefined || pricing.request === null) return true;
  return knownZero(pricing.request);
}

function textOutputCompatible(architecture: NonNullable<OpenRouterModelResponse['data']>[number]['architecture']): boolean {
  const output = architecture?.output_modalities;
  if (!Array.isArray(output)) return true;
  const modes = output.filter((value): value is string => typeof value === 'string');
  return modes.includes('text') && modes.every((mode) => mode === 'text');
}

/**
 * Fetch public OpenRouter catalogue ordering once per sort and cache the
 * resulting metadata. Only a runtime-reported `openrouter/<id>` is later
 * selectable; this helper never introduces a model into the picker.
 */
export async function getOpenRouterModelMetadata(
  sort: OpenRouterModelSort,
): Promise<ReadonlyMap<string, CatalogueModelMetadata> | null> {
  const cached = cache.get(sort);
  if (cached && cached.expiresAt > Date.now()) return cached.metadata;

  const url = new URL('https://openrouter.ai/api/v1/models');
  url.searchParams.set('sort', sort);
  url.searchParams.set('output_modalities', 'text');
  url.searchParams.set('supported_parameters', 'tools');

  try {
    const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(5_000) });
    if (!response.ok) return null;
    const body = await response.json() as OpenRouterModelResponse;
    if (!Array.isArray(body.data)) return null;
    const metadata = new Map<string, CatalogueModelMetadata>();
    body.data.forEach((model, rank) => {
      if (typeof model.id !== 'string' || !model.id.trim()) return;
      const label = typeof model.name === 'string' && model.name.trim() ? model.name.trim() : undefined;
      const free = freeFromPricing(model.id, model.pricing);
      const inputPricePerMillion = pricePerMillion(model.pricing?.prompt);
      const outputPricePerMillion = pricePerMillion(model.pricing?.completion);
      metadata.set(`openrouter/${model.id}`, {
        rank,
        ...(label ? { label } : {}),
        ...(free === undefined ? {} : { free }),
        compatible: textOutputCompatible(model.architecture),
        ...(typeof model.created === 'number' && Number.isFinite(model.created) && model.created > 0 ? { created: model.created } : {}),
        ...(typeof model.context_length === 'number' && Number.isFinite(model.context_length) && model.context_length > 0 ? { contextLength: model.context_length } : {}),
        ...(inputPricePerMillion === undefined ? {} : { inputPricePerMillion }),
        ...(outputPricePerMillion === undefined ? {} : { outputPricePerMillion }),
        ...(model.id.startsWith('stealth/') || (typeof model.description === 'string' && /\bstealth model\b/i.test(model.description)) ? { stealth: true } : {}),
      });
    });
    cache.set(sort, { metadata, expiresAt: Date.now() + CACHE_TTL_MS });
    return metadata;
  } catch {
    return null;
  }
}

/** Test seam for the module cache. */
export function clearOpenRouterModelMetadataCache(): void {
  cache.clear();
}
