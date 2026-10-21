import { NextRequest, NextResponse } from 'next/server';

import { catalogueSize } from '@/lib/orchestrator/acp-model-catalogue';
import { requirePanelAuth } from '@/lib/panel/auth';
import { getThreecodeModelCatalogue, THREECODE_CATALOGUE_UNAVAILABLE } from '@/lib/runtimes/threecode-model-catalogue';
import { getOpenRouterModelMetadata } from '@/lib/orchestrator/openrouter-model-metadata';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;
  try {
    const catalogue = await getThreecodeModelCatalogue({
      force: request.nextUrl.searchParams.get('refresh') === '1',
    });
    const metadata = catalogue.groups.some((group) => group.models.some((model) => model.id.startsWith('openrouter.')))
      ? await getOpenRouterModelMetadata(request.nextUrl.searchParams.get('sort') === 'newest' ? 'newest' : 'most-popular') : null;
    const groups = catalogue.groups.map((group) => ({ ...group, models: group.models.map((model) => ({ ...model,
      ...(model.id.startsWith('openrouter.') && metadata?.has(`openrouter/${model.id.slice('openrouter.'.length)}`) ? { metadata: metadata.get(`openrouter/${model.id.slice('openrouter.'.length)}`) } : {}),
    })).sort((a, b) => (a.metadata?.rank ?? Infinity) - (b.metadata?.rank ?? Infinity) || a.id.localeCompare(b.id)) }));
    return NextResponse.json({
      available: true,
      groups,
      total: catalogueSize(groups),
      rankingAvailable: groups.some((group) => group.models.some((model) => model.metadata !== undefined)),
      source: catalogue.source,
    });
  } catch {
    return NextResponse.json({
      available: true,
      groups: [],
      total: 0,
      error: THREECODE_CATALOGUE_UNAVAILABLE,
    }, { status: 503 });
  }
}
