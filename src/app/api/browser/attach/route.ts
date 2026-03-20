export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { setAttachedBrowserSummary } from '@/lib/browser/attachment-state';
import { getBrowserProvider } from '@/lib/browser/inventory';
import { requestRealtimeRefresh } from '@/lib/realtime/publisher';

export async function POST(request: Request) {
  const body = await request.json().catch(() => null) as {
    provider?: string;
    surfaceId?: string;
  } | null;

  const providerId = body?.provider?.trim();
  const surfaceId = body?.surfaceId?.trim();
  if (!providerId || !surfaceId) {
    return NextResponse.json({ error: 'provider and surfaceId are required' }, { status: 400 });
  }

  const provider = getBrowserProvider(providerId);
  if (!provider) {
    return NextResponse.json({ error: `Unknown browser provider: ${providerId}` }, { status: 404 });
  }

  if (!provider.attachSurface) {
    return NextResponse.json(
      { error: `${provider.displayName} does not support attach yet.` },
      { status: 400 },
    );
  }

  try {
    const attachment = await provider.attachSurface(surfaceId);
    setAttachedBrowserSummary(attachment);
    void requestRealtimeRefresh({
      targets: ['global'],
      fresh: true,
      reason: `browser.attach:${providerId}`,
    });
    return NextResponse.json({ attachment });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unable to attach browser surface' },
      { status: 500 },
    );
  }
}
