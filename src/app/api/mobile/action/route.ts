import { NextRequest, NextResponse } from 'next/server';
import { invalidateCommandCenterSnapshotCaches } from '@/lib/command-center/snapshot';
import { invalidateInboxCache } from '@/lib/mobile/openclaw';
import type { MobileActionRequest, MobileActionResponse } from '@/lib/mobile/types';
import { publishRealtimeMutation } from '@/lib/realtime/publisher';
import { launchCodexFromMobile, performRuntimeAction } from '@/lib/runtime/actions';
import { steerOpenClawSession } from '@/lib/openclaw/chat';
import '@/lib/runtimes'; // Ensure runtimes are registered
import { getRuntime } from '@/lib/runtimes/registry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function previewMessage(message?: string) {
  if (!message) return '';
  return message.trim().replace(/\s+/g, ' ').slice(0, 160);
}

function invalidateMutationCaches() {
  invalidateCommandCenterSnapshotCaches();
  invalidateInboxCache();
}

async function publishMobileMutation(
  mutationId: string,
  payload: {
    action: string;
    sessionKey?: string;
    runtime?: string;
    status: 'pending' | 'queued' | 'completed' | 'failed';
    note: string;
  },
) {
  await publishRealtimeMutation({
    mutation: {
      mutationId,
      source: 'mobile',
      action: payload.action,
      runtime: payload.runtime,
      surfaceId: payload.sessionKey,
      sessionKey: payload.sessionKey,
      status: payload.status,
      note: payload.note,
      createdAt: new Date().toISOString(),
      settledAt: payload.status === 'pending' ? undefined : new Date().toISOString(),
    },
    refreshTargets: ['global', 'mobileInbox', ...(payload.sessionKey ? ['sessionHistory' as const] : [])],
    sessionKeys: payload.sessionKey ? [payload.sessionKey] : [],
    fresh: payload.status !== 'failed',
  });
}

export async function POST(request: NextRequest) {
  const payload = (await request.json().catch(() => null)) as MobileActionRequest | null;
  const action = payload?.action;
  const sessionKey = payload?.sessionKey?.trim();

  if (!action || !sessionKey) {
    return NextResponse.json({ error: 'action and sessionKey are required' }, { status: 400 });
  }

  const clientMutationId = payload?.clientMutationId?.trim() || `mutation-${Date.now()}`;

  try {
    const isOwnedCodex = sessionKey.startsWith('codex-owned:');
    console.info('[mobile/action] request', {
      action,
      sessionKey,
      clientMutationId,
      cwd: payload?.cwd,
      hasMessage: Boolean(payload?.message?.trim()),
      attachmentCount: payload?.attachments?.length ?? 0,
      messagePreview: previewMessage(payload?.message),
    });

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
          clientMutationId,
          status: 'sent',
          note: `Message sent to ${sessionKey}`,
          runId: (result as Record<string, unknown>)?.runId as string | undefined,
        };
        invalidateMutationCaches();
        await publishMobileMutation(clientMutationId, {
          action: 'send',
          sessionKey,
          runtime: 'openclaw',
          status: 'queued',
          note: response.note,
        });
        console.info('[mobile/action] send queued', { sessionKey, clientMutationId, runId: response.runId ?? null });
        return NextResponse.json(response, {
          headers: { 'Cache-Control': 'no-store, max-age=0' },
        });
      } catch (err) {
        const note = err instanceof Error ? err.message : 'Send failed';
        await publishMobileMutation(clientMutationId, {
          action: 'send',
          sessionKey,
          runtime: 'openclaw',
          status: 'failed',
          note,
        });
        console.warn('[mobile/action] send failed', { sessionKey, clientMutationId, note });
        return NextResponse.json(
          { ok: false, action: 'send', sessionKey, clientMutationId, status: 'error', note },
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
        clientMutationId,
        status: result.status,
        note: result.note,
      };
      if (result.ok) {
        invalidateMutationCaches();
      }
      console.info('[mobile/action] launch result', {
        requestedSessionKey: sessionKey,
        resolvedSessionKey: response.sessionKey,
        clientMutationId,
        ok: result.ok,
        status: result.status,
      });
      await publishMobileMutation(clientMutationId, {
        action,
        sessionKey: response.sessionKey,
        runtime: 'codex',
        status: result.ok ? 'queued' : 'failed',
        note: result.note,
      });
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
          clientMutationId,
          message,
          runId: payload?.runId,
        });

        const response: MobileActionResponse = {
          ok: result.ok,
          action,
          sessionKey,
          clientMutationId,
          status: result.status,
          note: result.note,
          runId: result.runId,
          aborted: result.aborted,
        };
        if (result.ok) {
          invalidateMutationCaches();
        }
        console.info('[mobile/action] owned resume result', {
          sessionKey,
          clientMutationId,
          ok: result.ok,
          status: result.status,
          runId: result.runId ?? null,
        });
        await publishMobileMutation(clientMutationId, {
          action,
          sessionKey,
          runtime: 'codex',
          status: result.ok ? (result.status === 'queued' ? 'queued' : 'completed') : 'failed',
          note: result.note,
        });

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
        if (result.ok) {
          invalidateMutationCaches();
        }
        console.info('[mobile/action] claude-code resume result', {
          sessionKey,
          clientMutationId,
          ok: result.ok,
          note: result.note,
        });
        await publishMobileMutation(clientMutationId, {
          action,
          sessionKey,
          runtime: 'claude-code',
          status: result.ok ? 'queued' : 'failed',
          note: result.note,
        });
        return NextResponse.json(
          { ok: result.ok, action, sessionKey, clientMutationId, status: result.ok ? 'sent' : 'error', note: result.note },
          { status: result.ok ? 200 : 500, headers: { 'Cache-Control': 'no-store, max-age=0' } },
        );
      }

      // Route 3: Discovered Codex sessions — route through the same steer lane
      // used by the runtime action contract so stale mobile clients still
      // target the mirrored backend session instead of spawning local CLI work.
      if (sessionKey.startsWith('codex:') || sessionKey.startsWith('codex-discovered:')) {
        const result = await performRuntimeAction({
          action: 'steer',
          surfaceId: sessionKey,
          clientMutationId,
          message,
        });
        if (result.ok) {
          invalidateMutationCaches();
        }
        console.info('[mobile/action] discovered codex resume result', {
          sessionKey,
          clientMutationId,
          ok: result.ok,
          status: result.status,
          runId: result.runId ?? null,
        });
        await publishMobileMutation(clientMutationId, {
          action,
          sessionKey,
          runtime: 'codex',
          status: result.ok ? (result.status === 'queued' ? 'queued' : 'completed') : 'failed',
          note: result.note,
        });
        return NextResponse.json(
          {
            ok: result.ok,
            action,
            sessionKey,
            clientMutationId,
            status: result.status,
            note: result.note,
            runId: result.runId,
            aborted: result.aborted,
          },
          { status: result.status === 'unavailable' ? 501 : 200, headers: { 'Cache-Control': 'no-store, max-age=0' } },
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
        clientMutationId,
      });

      const response: MobileActionResponse = {
        ok: result.ok,
        action,
        sessionKey,
        clientMutationId,
        status: result.status,
        note: result.note,
      };
      if (result.ok) {
        invalidateMutationCaches();
      }
      await publishMobileMutation(clientMutationId, {
        action,
        sessionKey,
        runtime: 'codex',
        status: result.ok ? 'completed' : 'failed',
        note: result.note,
      });

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
      clientMutationId,
      message: payload?.message,
      attachments: payload?.attachments,
      runId: payload?.runId,
    });

    const response: MobileActionResponse = {
      ok: result.ok,
      action,
      sessionKey,
      clientMutationId,
      status: result.status,
      note: result.note,
      runId: result.runId,
      aborted: result.aborted,
    };
    if (result.ok) {
      invalidateMutationCaches();
    }
    console.info('[mobile/action] runtime action result', {
      action,
      sessionKey,
      clientMutationId,
      ok: result.ok,
      status: result.status,
      runId: result.runId ?? null,
    });
    await publishMobileMutation(clientMutationId, {
      action,
      sessionKey,
      runtime: sessionKey.startsWith('codex') ? 'codex' : 'openclaw',
      status: result.ok ? (result.status === 'queued' ? 'queued' : 'completed') : 'failed',
      note: result.note,
    });

    return NextResponse.json(response, {
      status: result.status === 'unavailable' ? 501 : 200,
      headers: {
        'Cache-Control': 'no-store, max-age=0',
      },
    });
  } catch (error) {
    console.error('[mobile/action] request failed', {
      action,
      sessionKey,
      clientMutationId,
      error: error instanceof Error ? error.message : String(error),
    });
    await publishMobileMutation(clientMutationId, {
      action,
      sessionKey,
      status: 'failed',
      note: error instanceof Error ? error.message : 'Unable to perform mobile action',
    });
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Unable to perform mobile action',
      },
      { status: 500 },
    );
  }
}
