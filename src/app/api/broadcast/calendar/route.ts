import { resolveRequestPrincipalContext } from '@/lib/auth/principal';
import {
  CalendarAttentionError,
  recordCalendarAttention,
} from '@/lib/broadcast/calendar-attention';
import { broadcastNoStore } from '@/lib/broadcast/route-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null);
    const result = recordCalendarAttention(body, resolveRequestPrincipalContext(request));
    return broadcastNoStore({
      schema: 'o8/broadcast.calendar-attention/v1',
      ok: true,
      result,
    });
  } catch (error) {
    if (error instanceof CalendarAttentionError) {
      return broadcastNoStore({
        schema: 'o8/broadcast.calendar-attention.error/v1',
        ok: false,
        error: { code: error.code, message: error.message },
      }, error.status);
    }
    console.error('[broadcast] Calendar attention persistence failed:', error);
    return broadcastNoStore({
      schema: 'o8/broadcast.calendar-attention.error/v1',
      ok: false,
      error: {
        code: 'calendar_attention_failed',
        message: 'Calendar attention could not be persisted.',
      },
    }, 503);
  }
}
