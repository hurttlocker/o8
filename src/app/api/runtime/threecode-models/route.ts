import { NextRequest, NextResponse } from 'next/server';

import { catalogueSize } from '@/lib/orchestrator/acp-model-catalogue';
import { requirePanelAuth } from '@/lib/panel/auth';
import { getThreecodeModelCatalogue, THREECODE_CATALOGUE_UNAVAILABLE } from '@/lib/runtimes/threecode-model-catalogue';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;
  try {
    const catalogue = await getThreecodeModelCatalogue({
      force: request.nextUrl.searchParams.get('refresh') === '1',
    });
    return NextResponse.json({
      available: true,
      groups: catalogue.groups,
      total: catalogueSize(catalogue.groups),
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
