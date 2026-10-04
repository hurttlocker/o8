import { deviceRequestIsLocal, deviceResponse, requestDeviceService, validDeviceGrant } from '@/lib/auth/device-session-service';
import { deleteDeviceSession, deviceSessionGeneration, readDeviceSession, writeDeviceSession } from '@/lib/auth/device-session-store';
import { readAuthSignedOutAt } from '@/lib/auth/sign-out-marker';
import { readSignInEpoch } from '@/lib/github-broker/managed';

export const dynamic = 'force-dynamic';

interface RenewalResult {
  status: number;
  body: { ticket: string; clerkUserId: string } | { ok: false; reason: string };
}

let inFlight: Promise<RenewalResult> | null = null;

async function renew(): Promise<RenewalResult> {
  const fail = (reason: string, status: number): RenewalResult => ({ status, body: { ok: false, reason } });
  try {
    if (readAuthSignedOutAt() !== null) {
      deleteDeviceSession();
      return fail('signed_out', 401);
    }
    const session = readDeviceSession();
    if (!session) return fail('no_device', 401);
    const generation = deviceSessionGeneration();
    const epoch = readSignInEpoch();
    const response = await requestDeviceService('renew', session.token, { installId: session.installId });
    const current = () => generation === deviceSessionGeneration() && readDeviceSession()?.token === session.token
      && epoch === readSignInEpoch() && readAuthSignedOutAt() === null;
    if (response.status === 401 || response.status === 403) {
      if (current()) deleteDeviceSession();
      return fail(response.status === 401 ? 'device_invalid' : 'account_blocked', response.status);
    }
    if (!response.ok) return fail('device_renew_failed', 503);
    const data = await response.json();
    if (!data || !validDeviceGrant(data) || typeof data.ticket !== 'string' || !data.ticket.trim()) {
      return fail('invalid_device_response', 502);
    }
    if (!current() || data.clerkUserId !== session.clerkUserId) {
      if (current()) deleteDeviceSession();
      await requestDeviceService('revoke', data.deviceToken).catch(() => {});
      return fail(data.clerkUserId !== session.clerkUserId ? 'device_owner_mismatch' : 'device_state_changed', 409);
    }
    writeDeviceSession({ ...session, token: data.deviceToken, idleExpiresAt: data.idleExpiresAt });
    return { status: 200, body: { ticket: data.ticket, clerkUserId: session.clerkUserId } };
  } catch {
    return fail('device_renew_failed', 503);
  }
}

export async function POST(request: Request) {
  if (!deviceRequestIsLocal(request)) return deviceResponse({ ok: false, reason: 'local_only' }, 403);
  if (!inFlight) inFlight = renew().finally(() => { inFlight = null; });
  const result = await inFlight;
  return deviceResponse(result.body, result.status);
}
