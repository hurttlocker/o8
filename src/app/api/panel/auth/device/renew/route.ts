import { deviceRequestIsLocal, deviceResponse, requestDeviceService, retryPendingDeviceRevokes, validDeviceGrant } from '@/lib/auth/device-session-service';
import { deleteDeviceSession, deviceSessionGeneration, queueDeviceRevoke, readDeviceSession, writeDeviceSession } from '@/lib/auth/device-session-store';
import { readAuthSignedOutAt } from '@/lib/auth/sign-out-marker';
import { readSignInEpoch } from '@/lib/github-broker/managed';

export const dynamic = 'force-dynamic';

interface RenewalResult {
  status: number;
  body: { ticket: string; clerkUserId: string } | { ok: false; reason: string };
}

let inFlight: Promise<RenewalResult> | null = null;
const RECOVERY_MS = 60_000;
const MAX_RETRIES = 3;

async function renew(): Promise<RenewalResult> {
  const fail = (reason: string, status: number): RenewalResult => ({ status, body: { ok: false, reason } });
  try {
    if (readAuthSignedOutAt() !== null) {
      deleteDeviceSession();
      return fail('signed_out', 401);
    }
    const session = readDeviceSession();
    if (!session) return fail('no_device', 401);
    const startedAt = session.renewalStartedAt ?? Date.now();
    // A crash or sleep must not make a later launch replay a superseded token.
    if (session.renewalStartedAt === undefined) writeDeviceSession({ ...session, renewalStartedAt: startedAt });
    const generation = deviceSessionGeneration();
    const epoch = readSignInEpoch();
    const ownsFile = () => readDeviceSession()?.token === session.token;
    const current = () => generation === deviceSessionGeneration() && readDeviceSession()?.token === session.token
      && epoch === readSignInEpoch() && readAuthSignedOutAt() === null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      const remaining = RECOVERY_MS - (Date.now() - startedAt);
      if (remaining <= 0 || !current()) break;
      try {
        const response = await requestDeviceService('renew', session.token, { installId: session.installId }, AbortSignal.timeout(remaining));
        if (response.status === 401 || response.status === 403) {
          if (ownsFile()) deleteDeviceSession();
          return fail(response.status === 401 ? 'device_invalid' : 'account_blocked', response.status);
        }
        if (!response.ok) continue;
        const data = await response.json();
        if (!data || !validDeviceGrant(data) || typeof data.ticket !== 'string' || !data.ticket.trim()) continue;
        if (!current() || data.clerkUserId !== session.clerkUserId) {
          // Epoch changes invalidate activation, not ownership of the old file.
          try {
            queueDeviceRevoke(data.deviceToken);
          } finally {
            if (ownsFile()) deleteDeviceSession();
          }
          await retryPendingDeviceRevokes();
          return fail(data.clerkUserId !== session.clerkUserId ? 'device_owner_mismatch' : 'device_state_changed', 409);
        }
        // Drop the uncertainty timestamp only after persisting the rotated token.
        writeDeviceSession({ token: data.deviceToken, clerkUserId: session.clerkUserId,
          installId: session.installId, idleExpiresAt: data.idleExpiresAt });
        return { status: 200, body: { ticket: data.ticket, clerkUserId: session.clerkUserId } };
      } catch {
        // The request may already have rotated upstream. Retry inside grace.
      }
    }
    // Mark recovery exhausted before queuing. If storage fails, a later call
    // can retry revocation but must never send this token to renew again.
    if (ownsFile()) writeDeviceSession({ ...session, renewalStartedAt: Math.min(startedAt, Date.now() - RECOVERY_MS) });
    queueDeviceRevoke(session.token);
    if (ownsFile()) deleteDeviceSession();
    await retryPendingDeviceRevokes();
    return fail('device_renew_failed', 503);
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
