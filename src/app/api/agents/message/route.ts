import { NextRequest } from 'next/server';

import { resolveRequestPrincipalContext } from '@/lib/auth/principal';
import { createAgentMessagePostHandler } from '@/lib/agents/message-route-handler';
import { AgentBusError, readAgentExchanges, readAllAgentExchanges } from '@/lib/agents/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = createAgentMessagePostHandler();

function limit(value: string | null): number {
  if (!value) return 12;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 50) {
    throw new AgentBusError('limit must be an integer from 1 through 50.', 'invalid_agent_exchange_limit', 400);
  }
  return parsed;
}

export async function GET(request: NextRequest): Promise<Response> {
  try {
    const principal = resolveRequestPrincipalContext(request);
    const requestedLimit = limit(request.nextUrl.searchParams.get('limit'));
    const result = request.nextUrl.searchParams.get('scope') === 'all'
      ? readAllAgentExchanges(requestedLimit, principal)
      : readAgentExchanges({
        repo: request.nextUrl.searchParams.get('repo'),
        limit: requestedLimit,
      }, principal);
    return Response.json({ schema: 'o8/agents.exchanges/v1', ...result }, {
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    });
  } catch (error) {
    if (error instanceof AgentBusError) {
      return Response.json({
        schema: 'o8/agents.exchanges.error/v1',
        ok: false,
        error: { code: error.code, message: error.message },
      }, { status: error.status });
    }
    console.error('[agent-message] Exchange read failed:', error);
    return Response.json({
      schema: 'o8/agents.exchanges.error/v1',
      ok: false,
      error: { code: 'agent_exchanges_failed', message: 'Recent agent exchanges are temporarily unavailable.' },
    }, { status: 503 });
  }
}
