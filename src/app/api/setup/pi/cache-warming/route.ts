import { NextResponse } from 'next/server';
import { isPiCacheWarming } from '@/lib/pi/cache-warming';
import { setPiCacheWarming } from '@/lib/pi/cache-warming-settings';
import { invalidateRuntimeAuthCache } from '@/lib/runtimes/shared/auth-detect';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const body: unknown = await request.json().catch(() => null);
  const mode = body && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>).cacheWarming : undefined;
  if (!isPiCacheWarming(mode)) {
    return NextResponse.json({ error: 'Choose Off, During runs, or During and between runs.' }, { status: 400 });
  }
  try {
    await setPiCacheWarming(mode);
    invalidateRuntimeAuthCache();
    return NextResponse.json({ ok: true, cacheWarming: mode });
  } catch {
    return NextResponse.json({ error: 'Pi settings could not be saved. Check that Pi is 0.86.0 or newer and its settings file is a regular, valid JSON file, then retry.' }, { status: 409 });
  }
}
