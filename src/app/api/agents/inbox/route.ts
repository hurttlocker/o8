import { NextRequest } from 'next/server';

import { resolveRequestPrincipalContext } from '@/lib/auth/principal';
import { AgentBusError, readAgentInbox } from '@/lib/agents/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function limit(value: string | null): number {
  if (!value) return 50;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 100) {
    throw new AgentBusError('limit must be an integer from 1 through 100.', 'invalid_agent_inbox_limit', 400);
  }
  return parsed;
}

export async function GET(request: NextRequest): Promise<Response> {
  try {
    const params = request.nextUrl.searchParams;
    const page = readAgentInbox({
      agent: params.get('agent'),
      agentId: params.get('agentId'),
      cursor: params.get('cursor'),
      limit: limit(params.get('limit')),
    }, resolveRequestPrincipalContext(request));
    return Response.json({ schema: 'o8/agents.inbox/v1', ...page }, {
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    });
  } catch (error) {
    if (error instanceof AgentBusError) {
      return Response.json({
        schema: 'o8/agents.inbox.error/v1',
        ok: false,
        error: { code: error.code, message: error.message },
      }, { status: error.status });
    }
    console.error('[agent-message] Inbox read failed:', error);
    return Response.json({
      schema: 'o8/agents.inbox.error/v1',
      ok: false,
      error: { code: 'agent_inbox_failed', message: 'Agent inbox is temporarily unavailable.' },
    }, { status: 503 });
  }
}
