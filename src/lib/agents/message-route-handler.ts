import { resolveRequestPrincipalContext } from '@/lib/auth/principal';

import {
  defaultAgentMessageDeliverySeams,
  type AgentMessageDeliverySeams,
} from './delivery';
import {
  defaultLiveAgentPresenceSeams,
  type LiveAgentPresenceSeams,
} from './live-presence';
import { AgentBusError, postAgentMessage } from './service';

function response(body: unknown, status: number): Response {
  return Response.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store, max-age=0' },
  });
}

/**
 * Built here rather than in the route module: Next.js route files may export
 * only route fields, so a factory exported from `route.ts` fails the build's
 * route typegen even though `tsc --noEmit` accepts it.
 */
export function createAgentMessagePostHandler(
  seams: AgentMessageDeliverySeams = defaultAgentMessageDeliverySeams,
  presenceSeams: LiveAgentPresenceSeams = defaultLiveAgentPresenceSeams,
) {
  return async function POST(request: Request): Promise<Response> {
    try {
      const body = await request.json().catch(() => null);
      const message = await postAgentMessage(
        body,
        resolveRequestPrincipalContext(request),
        seams,
        undefined,
        presenceSeams,
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
