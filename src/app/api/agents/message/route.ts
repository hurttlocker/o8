import { resolveRequestPrincipalContext } from '@/lib/auth/principal';
import {
  AgentBusError,
  postAgentMessage,
} from '@/lib/agents/service';
import {
  defaultAgentMessageDeliverySeams,
  type AgentMessageDeliverySeams,
} from '@/lib/agents/delivery';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function response(body: unknown, status: number): Response {
  return Response.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store, max-age=0' },
  });
}

export function createAgentMessagePostHandler(
  seams: AgentMessageDeliverySeams = defaultAgentMessageDeliverySeams,
) {
  return async function POST(request: Request): Promise<Response> {
    try {
      const body = await request.json().catch(() => null);
      const message = await postAgentMessage(
        body,
        resolveRequestPrincipalContext(request),
        seams,
      );
      return response({ schema: 'o8/agents.message/v1', ok: true, message }, 201);
    } catch (error) {
      if (error instanceof AgentBusError) {
        return response({
          schema: 'o8/agents.message.error/v1',
          ok: false,
          error: { code: error.code, message: error.message },
        }, error.status);
      }
      console.error('[agent-message] Post failed:', error);
      return response({
        schema: 'o8/agents.message.error/v1',
        ok: false,
        error: { code: 'agent_message_failed', message: 'Agent message could not be persisted.' },
      }, 503);
    }
  };
}

export const POST = createAgentMessagePostHandler();
