import { NextRequest, NextResponse } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import { prepareRegistryAgent } from '@/lib/acp/registry-preparation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(request: NextRequest) {
  const denied = requirePanelAuth(request); if (denied) return denied;
  if (process.env.O8_ACP_COMMAND?.trim()) return NextResponse.json({ error: 'Your environment controls the ACP connection.' }, { status: 409 });
  try {
    const value = await request.json();
    if (typeof value.id !== 'string' || !/^[a-z0-9-]{1,80}$/.test(value.id) || typeof value.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(value.fingerprint)) return NextResponse.json({ error: 'Select an agent from the registry.' }, { status: 400 });
    return NextResponse.json({ connection: await prepareRegistryAgent({ id: value.id, fingerprint: value.fingerprint }) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not prepare this agent.' }, { status: 400 });
  }
}
