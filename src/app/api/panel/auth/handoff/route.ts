import { deviceRequestIsLocal, deviceResponse, revokeDesktopDeviceSession } from '@/lib/auth/device-session-service';
import { beginDesktopAuthHandoff, consumeDesktopAuthHandoff } from '@/lib/auth/device-session-store';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  if (!deviceRequestIsLocal(request)) return deviceResponse({ ok: false, reason: 'local_only' }, 403);
  try {
    const action = new URL(request.url).searchParams.get('action');
    if (action === 'begin') return deviceResponse({ ok: true, state: beginDesktopAuthHandoff() });
    if (action === 'cancel') {
      await revokeDesktopDeviceSession();
      return deviceResponse({ ok: true });
    }
    if (action === 'validate') {
      const body = await request.json().catch(() => null);
      if (typeof body?.state === 'string' && consumeDesktopAuthHandoff(body.state)) return deviceResponse({ ok: true });
      return deviceResponse({ ok: false, reason: 'invalid_handoff' }, 409);
    }
    return deviceResponse({ ok: false, reason: 'invalid_action' }, 400);
  } catch {
    return deviceResponse({ ok: false, reason: 'handoff_storage_error' }, 503);
  }
}
