import { resolveRequestPrincipalContext } from '@/lib/auth/principal';
import { BroadcastPostError, handleBroadcastSay } from '@/lib/broadcast/post';
import { broadcastNoStore } from '@/lib/broadcast/route-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null);
    const event = handleBroadcastSay(body, resolveRequestPrincipalContext(request));
    return broadcastNoStore({
      schema: 'o8/broadcast.say/v1',
      ok: true,
      event,
    });
  } catch (error) {
    if (error instanceof BroadcastPostError) {
      return broadcastNoStore({
        schema: 'o8/broadcast.say.error/v1',
        ok: false,
        error: { code: error.code, message: error.message },
      }, error.status);
    }
    console.error('[broadcast] Say persistence failed:', error);
    return broadcastNoStore({
      schema: 'o8/broadcast.say.error/v1',
      ok: false,
      error: { code: 'broadcast_say_failed', message: 'Broadcast speech could not be persisted.' },
    }, 503);
  }
}
