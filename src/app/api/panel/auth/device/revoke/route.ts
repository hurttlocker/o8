import { deviceRequestIsLocal, deviceResponse, requestDeviceService } from '@/lib/auth/device-session-service';
import { deleteDeviceSession, readDeviceSession } from '@/lib/auth/device-session-store';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  if (!deviceRequestIsLocal(request)) return deviceResponse({ ok: false, reason: 'local_only' }, 403);
  try {
    const session = readDeviceSession();
    // Invalidate before the network wait so a late renewal cannot restore it.
    deleteDeviceSession();
    if (session) await requestDeviceService('revoke', session.token).catch(() => {});
    return deviceResponse({ ok: true });
  } catch {
    return deviceResponse({ ok: false, reason: 'device_storage_error' }, 503);
  }
}
