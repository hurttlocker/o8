import { NextRequest, NextResponse } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import { readLocalAcpConnection, saveLocalAcpConnection } from '@/lib/acp/local-connection';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;
  return NextResponse.json({ connection: readLocalAcpConnection(), envLocked: Boolean(process.env.O8_ACP_COMMAND?.trim()) });
}
export async function POST(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;
  if (process.env.O8_ACP_COMMAND?.trim()) return NextResponse.json({ error: 'The ACP command is controlled by your environment.' }, { status: 409 });
  try {
    const body = await request.json();
    if (!Object.hasOwn(body, 'connection')) throw new Error('connection is required');
    return NextResponse.json({ connection: saveLocalAcpConnection(body.connection) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not save ACP connection.' }, { status: 400 });
  }
}
