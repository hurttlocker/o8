import { deviceRequestIsLocal, deviceResponse, retryPendingDeviceRevokes } from '@/lib/auth/device-session-service';
import { readDeviceSession } from '@/lib/auth/device-session-store';
import { readAuthSignedOutAt } from '@/lib/auth/sign-out-marker';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  if (!deviceRequestIsLocal(request)) return deviceResponse({ ok: false, reason: 'local_only' }, 403);
  try {
    await retryPendingDeviceRevokes();
    const session = readAuthSignedOutAt() === null ? readDeviceSession() : null;
    return deviceResponse({ present: Boolean(session), clerkUserId: session?.clerkUserId ?? null });
  } catch {
    return deviceResponse({ ok: false, reason: 'device_storage_error' }, 503);
  }
}
