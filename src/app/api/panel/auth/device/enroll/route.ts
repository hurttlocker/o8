import { deviceRequestIsLocal, deviceResponse, requestDeviceService, revokeDeviceToken, validDeviceGrant } from '@/lib/auth/device-session-service';
import { deviceSessionGeneration, readDeviceSession, writeDeviceSession } from '@/lib/auth/device-session-store';
import { readAuthSignedOutAt } from '@/lib/auth/sign-out-marker';
import { getOrCreateInstallId } from '@/lib/entitlement/bootstrap';
import { readSignInEpoch } from '@/lib/github-broker/managed';
import { version } from '../../../../../../../package.json';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  if (!deviceRequestIsLocal(request)) return deviceResponse({ ok: false, reason: 'local_only' }, 403);
  const sessionToken = request.headers.get('x-clerk-session-token')?.trim();
  if (!sessionToken) return deviceResponse({ ok: false, reason: 'no_session' }, 401);
  try {
    const body = await request.json().catch(() => null);
    if (!body || typeof body.clerkUserId !== 'string' || !body.clerkUserId.trim()) {
      return deviceResponse({ ok: false, reason: 'invalid_owner' }, 400);
    }
    if (readAuthSignedOutAt() !== null) return deviceResponse({ ok: false, reason: 'signed_out' }, 409);
    const generation = deviceSessionGeneration();
    const epoch = readSignInEpoch();
    const priorToken = readDeviceSession()?.token;
    const installId = getOrCreateInstallId();
    const response = await requestDeviceService('enroll', sessionToken, { installId, platform: process.platform, appVersion: version });
    if (!response.ok) return deviceResponse({ ok: false, reason: 'device_enroll_failed' }, response.status === 401 || response.status === 403 ? response.status : 503);
    const data = await response.json();
    if (!data || !validDeviceGrant(data)) return deviceResponse({ ok: false, reason: 'invalid_device_response' }, 502);
    const mismatch = data.clerkUserId !== body.clerkUserId.trim();
    if (mismatch || generation !== deviceSessionGeneration() || epoch !== readSignInEpoch()
      || priorToken !== readDeviceSession()?.token || readAuthSignedOutAt() !== null) {
      await revokeDeviceToken(data.deviceToken);
      return deviceResponse({ ok: false, reason: mismatch ? 'device_owner_mismatch' : 'device_state_changed' }, 409);
    }
    writeDeviceSession({ token: data.deviceToken, clerkUserId: data.clerkUserId, installId, idleExpiresAt: data.idleExpiresAt });
    return deviceResponse({ ok: true, clerkUserId: data.clerkUserId });
  } catch {
    return deviceResponse({ ok: false, reason: 'device_enroll_failed' }, 503);
  }
}
