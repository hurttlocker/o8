import { NextRequest, NextResponse } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import { ORCHESTRATOR_RUNTIMES } from '@/lib/orchestrator/runtime-capabilities';
import { runtimeBillingMode, saveRuntimeBillingMode } from '@/lib/providers/runtime-billing';
import { runtimeApiBillingUnavailable } from '@/lib/providers/runtime-billing-capabilities';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const known = (id: unknown): id is string => typeof id === 'string' && (Object.hasOwn(ORCHESTRATOR_RUNTIMES, id) || id === 'openclaw' || id === 'acp');
const response = (runtimeId: string) => NextResponse.json({ ok: true, runtimeId, mode: runtimeBillingMode(runtimeId) }, { headers: { 'Cache-Control': 'no-store' } });
export async function GET(request: NextRequest) {
  const denied = requirePanelAuth(request); if (denied) return denied;
  const runtimeId = request.nextUrl.searchParams.get('runtimeId');
  if (!known(runtimeId)) return NextResponse.json({ ok: false, error: 'Unknown runtime.' }, { status: 400 });
  return response(runtimeId);
}
export async function POST(request: NextRequest) {
  const denied = requirePanelAuth(request); if (denied) return denied;
  const body = await request.json().catch(() => null);
  if (!body || !known(body.runtimeId) || !['subscription', 'api'].includes(body.mode)) return NextResponse.json({ ok: false, error: 'Choose a runtime and subscription or api billing.' }, { status: 400 });
  const unavailable = runtimeApiBillingUnavailable(body.runtimeId);
  if (unavailable && body.mode === 'api') return NextResponse.json({ ok: false, code: unavailable.code, error: unavailable.error, issue: unavailable.url }, { status: 409 });
  try { saveRuntimeBillingMode(body.runtimeId, body.mode); return response(body.runtimeId); }
  catch { return NextResponse.json({ ok: false, error: 'Billing mode could not be saved. Previous mode is unchanged.' }, { status: 503 }); }
}
