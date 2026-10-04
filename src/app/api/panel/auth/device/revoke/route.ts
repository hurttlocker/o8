import { deviceRequestIsLocal, deviceResponse, retryPendingDeviceRevokes } from '@/lib/auth/device-session-service';
import { deleteDeviceSession, queueDeviceRevoke, readDeviceSession } from '@/lib/auth/device-session-store';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  if (!deviceRequestIsLocal(request)) return deviceResponse({ ok: false, reason: 'local_only' }, 403);
  try {
    const session = readDeviceSession();
    // Persist intent before deleting, including if this process exits mid-request.
    try {
      if (session) queueDeviceRevoke(session.token);
    } finally {
      // Invalidate even on storage failure, before a late renewal can restore it.
      deleteDeviceSession();
    }
    await retryPendingDeviceRevokes();
    return deviceResponse({ ok: true });
  } catch {
    return deviceResponse({ ok: false, reason: 'device_storage_error' }, 503);
  }
}
