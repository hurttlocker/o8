import { NextRequest, NextResponse } from 'next/server';
import type { MobileActionRequest, MobileActionResponse } from '@/lib/mobile/types';
import { launchCodexFromMobile, performRuntimeAction } from '@/lib/runtime/actions';
import { steerOpenClawSession } from '@/lib/openclaw/chat';
import { getRuntime } from '@/lib/runtimes/registry';

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

    // ── Send message to an OpenClaw agent session ──
    if (action === 'send') {
      const message = (payload as unknown as Record<string, unknown>)?.message as string | undefined;
      if (!message?.trim()) {
        return NextResponse.json(
          { error: 'message is required for send' },
          { status: 400, headers: { 'Cache-Control': 'no-store, max-age=0' } },
        );
      }
      try {
        const result = await steerOpenClawSession(sessionKey, message.trim());
        const response: MobileActionResponse = {
          ok: true,
          action: 'send',
          sessionKey,
          status: 'sent',
          note: `Message sent to ${sessionKey}`,
          runId: (result as Record<string, unknown>)?.runId as string | undefined,
        };
        return NextResponse.json(response, {
          headers: { 'Cache-Control': 'no-store, max-age=0' },
        });
      } catch (err) {
        return NextResponse.json(
          { ok: false, action: 'send', sessionKey, status: 'error', note: err instanceof Error ? err.message : 'Send failed' },
          { status: 500, headers: { 'Cache-Control': 'no-store, max-age=0' } },
        );
      }
    }

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
      const message = (payload as unknown as Record<string, unknown>)?.message as string | undefined;

      // Route 1: IDE-owned Codex — use existing performRuntimeAction path
      if (isOwnedCodex) {
        const result = await performRuntimeAction({
          action: 'send_input',
          surfaceId: sessionKey,
          message,
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
          headers: { 'Cache-Control': 'no-store, max-age=0' },
        });
      }

      // Route 2: Claude Code sessions — use claude-code runtime adapter
      if (sessionKey.startsWith('claude-code:')) {
        const ccRuntime = getRuntime('claude-code');
        if (!ccRuntime?.resume) {
          return NextResponse.json(
            { ok: false, action, sessionKey, status: 'unavailable', note: 'Claude Code runtime not available.' },
            { status: 501, headers: { 'Cache-Control': 'no-store, max-age=0' } },
          );
        }
        const result = await ccRuntime.resume(sessionKey, message ?? '');
        return NextResponse.json(
          { ok: result.ok, action, sessionKey, status: result.ok ? 'sent' : 'error', note: result.note },
          { status: result.ok ? 200 : 500, headers: { 'Cache-Control': 'no-store, max-age=0' } },
        );
      }

      // Route 3: Discovered Codex sessions — use codex runtime adapter
      if (sessionKey.startsWith('codex:') || sessionKey.startsWith('codex-discovered:')) {
        const codexRuntime = getRuntime('codex');
        if (!codexRuntime?.resume) {
          return NextResponse.json(
            { ok: false, action, sessionKey, status: 'unavailable', note: 'Codex runtime not available.' },
            { status: 501, headers: { 'Cache-Control': 'no-store, max-age=0' } },
          );
        }
        const result = await codexRuntime.resume(sessionKey, message ?? '');
        return NextResponse.json(
          { ok: result.ok, action, sessionKey, status: result.ok ? 'sent' : 'error', note: result.note },
          { status: result.ok ? 200 : 500, headers: { 'Cache-Control': 'no-store, max-age=0' } },
        );
      }

      // Route 4: Unknown session type
      return NextResponse.json(
        { ok: false, action, sessionKey, status: 'unavailable', note: `Don't know how to resume session: ${sessionKey.split(':')[0]}` },
        { status: 501, headers: { 'Cache-Control': 'no-store, max-age=0' } },
      );
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
