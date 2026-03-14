import { NextRequest, NextResponse } from 'next/server';
import type { MobileActionRequest, MobileActionResponse } from '@/lib/mobile/types';
import { launchCodexFromMobile, performRuntimeAction } from '@/lib/runtime/actions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const payload = (await request.json().catch(() => null)) as MobileActionRequest | null;
  const action = payload?.action;
  const sessionKey = payload?.sessionKey?.trim();

  if (!action || !sessionKey) {
    return NextResponse.json({ error: 'action and sessionKey are required' }, { status: 400 });
  }

  try {
    const isOwnedCodex = sessionKey.startsWith('codex-owned:');

    if (action === 'launch') {
      const cwd = payload?.cwd?.trim();
      const message = payload?.message?.trim();
      if (!cwd || !message) {
        return NextResponse.json(
          { error: 'cwd and message are required for launch' },
          { status: 400, headers: { 'Cache-Control': 'no-store, max-age=0' } },
        );
      }
      const result = await launchCodexFromMobile(cwd, message);
      const response: MobileActionResponse = {
        ok: result.ok,
        action,
        sessionKey: result.surfaceId ?? sessionKey,
        status: result.status,
        note: result.note,
      };
      return NextResponse.json(response, {
        status: 200,
        headers: { 'Cache-Control': 'no-store, max-age=0' },
      });
    }

    if (action === 'resume') {
      if (!isOwnedCodex) {
        const response: MobileActionResponse = {
          ok: false,
          action,
          sessionKey,
          status: 'unavailable',
          note: 'Resume is only wired truthfully for IDE-owned Codex sessions between runs on mobile right now.',
        };
        return NextResponse.json(response, {
          status: 501,
          headers: {
            'Cache-Control': 'no-store, max-age=0',
          },
        });
      }

      const result = await performRuntimeAction({
        action: 'send_input',
        surfaceId: sessionKey,
        message: payload?.message,
        runId: payload?.runId,
      });

      const response: MobileActionResponse = {
        ok: result.ok,
        action,
        sessionKey,
        status: result.status,
        note: result.note,
        runId: result.runId,
        aborted: result.aborted,
      };

      return NextResponse.json(response, {
        status: result.status === 'unavailable' ? 501 : 200,
        headers: {
          'Cache-Control': 'no-store, max-age=0',
        },
      });
    }

    if (action === 'watch' || action === 'resolve') {
      if (!isOwnedCodex) {
        const response: MobileActionResponse = {
          ok: false,
          action,
          sessionKey,
          status: 'unavailable',
          note: `${action} is only wired truthfully for IDE-owned Codex review packets on mobile right now.`,
        };
        return NextResponse.json(response, {
          status: 501,
          headers: {
            'Cache-Control': 'no-store, max-age=0',
          },
        });
      }

      const result = await performRuntimeAction({
        action,
        surfaceId: sessionKey,
      });

      const response: MobileActionResponse = {
        ok: result.ok,
        action,
        sessionKey,
        status: result.status,
        note: result.note,
      };

      return NextResponse.json(response, {
        status: result.status === 'unavailable' ? 501 : 200,
        headers: {
          'Cache-Control': 'no-store, max-age=0',
        },
      });
    }

    if (action !== 'steer' && action !== 'stop') {
      const response: MobileActionResponse = {
        ok: false,
        action,
        sessionKey,
        status: 'unavailable',
        note: `${action} is part of the mobile control contract, but it is not wired truthfully on the current runtime lane yet.`,
      };
      return NextResponse.json(response, {
        status: 501,
        headers: {
          'Cache-Control': 'no-store, max-age=0',
        },
      });
    }

    const result = await performRuntimeAction({
      action,
      surfaceId: sessionKey,
      message: payload?.message,
      attachments: payload?.attachments,
      runId: payload?.runId,
    });

    const response: MobileActionResponse = {
      ok: result.ok,
      action,
      sessionKey,
      status: result.status,
      note: result.note,
      runId: result.runId,
      aborted: result.aborted,
    };

    return NextResponse.json(response, {
      status: result.status === 'unavailable' ? 501 : 200,
      headers: {
        'Cache-Control': 'no-store, max-age=0',
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Unable to perform mobile action',
      },
      { status: 500 },
    );
  }
}
