import { NextRequest } from 'next/server';

import { resolveRequestPrincipalContext } from '@/lib/auth/principal';
import {
  AgentBusError,
  joinAgentPresence,
  readAgentPresence,
} from '@/lib/agents/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function agentError(error: AgentBusError): Response {
  return Response.json({
    schema: 'o8/agents.presence.error/v1',
    ok: false,
    error: { code: error.code, message: error.message },
  }, { status: error.status });
}

export async function GET(request: NextRequest): Promise<Response> {
  try {
    const agents = readAgentPresence(
      request.nextUrl.searchParams.get('repo'),
      resolveRequestPrincipalContext(request),
    );
    return Response.json({ schema: 'o8/agents.presence/v1', agents }, {
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    });
  } catch (error) {
    if (error instanceof AgentBusError) return agentError(error);
    console.error('[agent-presence] Read failed:', error);
    return Response.json({
      schema: 'o8/agents.presence.error/v1',
      ok: false,
      error: { code: 'agent_presence_failed', message: 'Agent presence is temporarily unavailable.' },
    }, { status: 503 });
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const body = await request.json().catch(() => null);
    const agent = joinAgentPresence(body, resolveRequestPrincipalContext(request));
    return Response.json({ schema: 'o8/agents.presence.join/v1', ok: true, agent }, {
      status: 201,
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    });
  } catch (error) {
    if (error instanceof AgentBusError) return agentError(error);
    if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) {
      return agentError(new AgentBusError(
        'That agent name is already registered in the repository.',
        'agent_name_conflict',
        409,
      ));
    }
    console.error('[agent-presence] Join failed:', error);
    return Response.json({
      schema: 'o8/agents.presence.error/v1',
      ok: false,
      error: { code: 'agent_presence_failed', message: 'Agent presence could not be registered.' },
    }, { status: 503 });
  }
}
