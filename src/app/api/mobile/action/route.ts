import { NextRequest, NextResponse } from 'next/server';
import type { MobileActionRequest, MobileActionResponse } from '@/lib/mobile/types';
import { abortOpenClawSession, steerOpenClawSession } from '@/lib/openclaw/chat';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function unavailable(sessionKey: string, action: MobileActionRequest['action'], note: string) {
  const payload: MobileActionResponse = {
    ok: false,
    action,
    sessionKey,
    status: 'unavailable',
    note,
  };

  return NextResponse.json(payload, { status: 501 });
}

export async function POST(request: NextRequest) {
  const payload = (await request.json().catch(() => null)) as MobileActionRequest | null;
  const action = payload?.action;
  const sessionKey = payload?.sessionKey?.trim();

  if (!action || !sessionKey) {
    return NextResponse.json({ error: 'action and sessionKey are required' }, { status: 400 });
  }

  try {
    switch (action) {
      case 'steer': {
        const message = payload?.message?.trim();
        if (!message) {
          return NextResponse.json({ error: 'message is required for steer' }, { status: 400 });
        }

        const result = await steerOpenClawSession(sessionKey, message);
        const response: MobileActionResponse = {
          ok: true,
          action,
          sessionKey,
          status: 'queued',
          note: 'Steer request queued on the live session.',
          runId: result.runId,
        };
        return NextResponse.json(response, {
          headers: {
            'Cache-Control': 'no-store, max-age=0',
          },
        });
      }
      case 'stop': {
        const result = await abortOpenClawSession(sessionKey, payload?.runId?.trim());
        const response: MobileActionResponse = {
          ok: true,
          action,
          sessionKey,
          status: 'completed',
          note: result.aborted
            ? 'Stop request sent to the active run for this session.'
            : 'No active run was in flight for this session.',
          aborted: result.aborted,
        };
        return NextResponse.json(response, {
          headers: {
            'Cache-Control': 'no-store, max-age=0',
          },
        });
      }
      case 'approve':
      case 'deny':
      case 'pause':
      case 'resume':
        return unavailable(sessionKey, action, `${action} is part of the mobile control contract, but it is not wired truthfully on the OpenClaw-backed lane yet.`);
      default:
        return NextResponse.json({ error: 'Unsupported mobile action' }, { status: 400 });
    }
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Unable to perform mobile action',
      },
      { status: 500 },
    );
  }
}
