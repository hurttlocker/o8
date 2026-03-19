import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const gatewayUrl = process.env.OPENCLAW_GATEWAY_URL || process.env.NEXT_PUBLIC_GATEWAY_URL || 'ws://127.0.0.1:18789';
  let connected = false;
  let version = 'unknown';
  let agentCount = 0;

  try {
    // Try HTTP status endpoint
    const httpUrl = gatewayUrl.replace('ws://', 'http://').replace('wss://', 'https://');
    const res = await fetch(`${httpUrl}/api/status`, {
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      const data = await res.json();
      connected = true;
      version = data.version || 'unknown';
      agentCount = data.agents?.length || 0;
    }
  } catch {
    // Gateway not reachable via HTTP — might still be WS-only
    connected = false;
  }

  return NextResponse.json({
    connected,
    gatewayUrl: gatewayUrl.replace(/^wss?:\/\//, ''),
    version,
    agentCount,
  });
}
