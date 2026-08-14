import { NextRequest, NextResponse } from 'next/server';

import { ensureCodexSubscriptionProxyReady } from '@/lib/claude-code/codex-subscription-proxy';
import { buildModelCatalogue, catalogueSize } from '@/lib/orchestrator/acp-model-catalogue';
import { requirePanelAuth } from '@/lib/panel/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;
  try {
    const connection = await ensureCodexSubscriptionProxyReady();
    const groups = buildModelCatalogue(connection.models.map((id) => ({ value: id, name: id })));
    return NextResponse.json({
      available: true,
      groups,
      total: catalogueSize(groups),
      source: 'codex-subscription',
    }, { headers: { 'Cache-Control': 'no-store, max-age=0' } });
  } catch (error) {
    return NextResponse.json({
      available: false,
      groups: [],
      total: 0,
      source: 'unavailable',
      error: error instanceof Error ? error.message : 'The Codex subscription model catalogue is unavailable.',
    }, { status: 409 });
  }
}
