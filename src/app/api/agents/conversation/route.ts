import { NextRequest } from 'next/server';

import { resolveRequestPrincipalContext } from '@/lib/auth/principal';
import { AgentBusError, changeAgentConversation, readAgentConversations } from '@/lib/agents/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function errorResponse(error: unknown): Response {
  if (error instanceof AgentBusError) {
    return Response.json({ ok: false, error: { code: error.code, message: error.message } }, { status: error.status });
  }
  console.error('[agent-conversation] Request failed:', error);
  return Response.json({
    ok: false,
    error: { code: 'agent_conversation_failed', message: 'Agent conversations are temporarily unavailable.' },
  }, { status: 503 });
}

export async function GET(request: NextRequest): Promise<Response> {
  try {
    const value = request.nextUrl.searchParams.get('limit');
    const limit = value === null ? 50 : Number(value);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new AgentBusError('limit must be an integer from 1 through 100.', 'invalid_agent_conversation_limit', 400);
    }
    return Response.json({
      schema: 'o8/agents.conversations/v1',
      ...readAgentConversations({ repo: request.nextUrl.searchParams.get('repo'), limit }, resolveRequestPrincipalContext(request)),
    }, { headers: { 'Cache-Control': 'no-store, max-age=0' } });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const conversation = changeAgentConversation(await request.json().catch(() => null), resolveRequestPrincipalContext(request));
    return Response.json({ schema: 'o8/agents.conversation/v1', ok: true, conversation }, {
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
