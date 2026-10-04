import { deviceRequestIsLocal, deviceResponse, revokeDesktopDeviceSession } from '@/lib/auth/device-session-service';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  if (!deviceRequestIsLocal(request)) return deviceResponse({ ok: false, reason: 'local_only' }, 403);
  try {
    await revokeDesktopDeviceSession();
    return deviceResponse({ ok: true });
  } catch {
    return deviceResponse({ ok: false, reason: 'device_storage_error' }, 503);
  }
}
