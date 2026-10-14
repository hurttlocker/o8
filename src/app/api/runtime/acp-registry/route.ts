import { NextRequest, NextResponse } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import { readAcpRegistry } from '@/lib/acp/registry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: NextRequest) {
  const denied = requirePanelAuth(request); if (denied) return denied;
  try { return NextResponse.json(await readAcpRegistry(request.nextUrl.searchParams.get('refresh') === '1')); }
  catch { return NextResponse.json({ error: 'Could not load ACP agents. Retry or use a local executable.' }, { status: 503 }); }
}
