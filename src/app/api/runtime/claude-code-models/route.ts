import { NextRequest, NextResponse } from 'next/server';

import { buildModelCatalogue, catalogueSize } from '@/lib/orchestrator/acp-model-catalogue';
import { requirePanelAuth } from '@/lib/panel/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CATALOGUE_URL = 'https://openrouter.ai/api/v1/models';
const CACHE_TTL_MS = 15 * 60_000;

type OpenRouterModel = {
  id?: unknown;
  name?: unknown;
  supported_parameters?: unknown;
};

let cache: { groups: ReturnType<typeof buildModelCatalogue>; fetchedAt: number } | null = null;

function supportsClaudeCodeTools(model: OpenRouterModel): boolean {
  if (!Array.isArray(model.supported_parameters)) return false;
  const parameters = new Set(model.supported_parameters.filter((value): value is string => typeof value === 'string'));
  return parameters.has('tools') && parameters.has('tool_choice');
}

export async function GET(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;

  const force = request.nextUrl.searchParams.get('refresh') === '1';
  if (!force && cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return NextResponse.json({ available: true, groups: cache.groups, total: catalogueSize(cache.groups), source: 'cache' });
  }

  try {
    const response = await fetch(CATALOGUE_URL, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
      cache: 'no-store',
    });
    if (!response.ok) throw new Error(`Model catalogue returned HTTP ${response.status}.`);
    const payload = await response.json() as { data?: OpenRouterModel[] };
    const options = (Array.isArray(payload.data) ? payload.data : [])
      .filter(supportsClaudeCodeTools)
      .flatMap((model) => typeof model.id === 'string' && model.id.trim()
        ? [{ value: model.id.trim(), name: typeof model.name === 'string' ? model.name : undefined }]
        : []);
    const groups = buildModelCatalogue(options);
    cache = { groups, fetchedAt: Date.now() };
    return NextResponse.json({ available: true, groups, total: catalogueSize(groups), source: 'live' });
  } catch (error) {
    return NextResponse.json({
      available: true,
      groups: cache?.groups ?? [],
      total: cache ? catalogueSize(cache.groups) : 0,
      source: cache ? 'stale-cache' : 'unavailable',
      error: error instanceof Error ? error.message : 'The model catalogue is unavailable.',
    }, { status: cache ? 200 : 503 });
  }
}
