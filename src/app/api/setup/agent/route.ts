import { NextResponse } from 'next/server';
import { agentSetupStatus, mutateAgentSetup } from '@/lib/setup/agent-setup';
import { readAgentSetupRequest } from '@/lib/setup/agent-request-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'no-store, max-age=0' };
function failure(error: unknown, status: number) {
  return NextResponse.json({ ok: false, error: { code: 'setup_failed', message: error instanceof Error ? error.message : 'Setup failed.' } }, { status, headers });
}
// The default-deny API middleware requires the operator credential on this route.
export async function GET(request: Request) {
  try {
    return NextResponse.json(new URL(request.url).searchParams.get('view') === 'request'
      ? { request: readAgentSetupRequest() } : await agentSetupStatus(), { headers });
  } catch (error) { return failure(error, 500); }
}
export async function POST(request: Request) {
  try {
    const body: unknown = await request.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) return failure(new Error('Expected a setup object.'), 400);
    return NextResponse.json(await mutateAgentSetup(body as Record<string, unknown>), { headers });
  } catch (error) { return failure(error, 400); }
}
