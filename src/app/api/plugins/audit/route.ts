import { NextResponse } from 'next/server';
import { resolveRequestPrincipal } from '@/lib/auth/principal';
import { readPluginAudit } from '@/lib/mcp/plugin-audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(request: Request): Response {
  if (resolveRequestPrincipal(request) !== 'operator') {
    return NextResponse.json({ error: 'operator_required' }, { status: 403 });
  }
  try {
    return NextResponse.json({ events: readPluginAudit() }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return NextResponse.json({ error: 'audit_unavailable' }, { status: 503 });
  }
}
