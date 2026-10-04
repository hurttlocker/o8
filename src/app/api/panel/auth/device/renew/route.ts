import { performance } from 'node:perf_hooks';
import { deviceRequestIsLocal, deviceResponse, requestDeviceService, retryPendingDeviceRevokes, validDeviceGrant } from '@/lib/auth/device-session-service';
import { deleteDeviceSession, deviceSessionGeneration, queueDeviceRevoke, readDeviceSession, removePendingDeviceRevoke, writeDeviceSession } from '@/lib/auth/device-session-store';
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
    const session = readDeviceSession();
    if (readAuthSignedOutAt() !== null) {
      try {
        if (session?.renewalStartedAt !== undefined) removePendingDeviceRevoke(session.token);
      } finally {
        deleteDeviceSession();
      }
      return fail('signed_out', 401);
    }
    if (!session) return fail('no_device', 401);
    // Only this invocation may recover a request it sent. Persisted uncertainty
    // from another process/invocation cannot establish the server's grace window.
    if (session.renewalStartedAt !== undefined) {
      try { removePendingDeviceRevoke(session.token); } finally { deleteDeviceSession(); }
      return fail('device_uncertain', 401);
    }
    const startedAt = Date.now();
    const monotonicStart = performance.now();
    const remaining = () => {
      const wallElapsed = Date.now() - startedAt;
      const monotonicElapsed = performance.now() - monotonicStart;
      if (!Number.isFinite(wallElapsed) || !Number.isFinite(monotonicElapsed)
        || wallElapsed < 0 || monotonicElapsed < 0) return 0;
      return Math.max(0, Math.ceil(RECOVERY_MS - Math.max(wallElapsed, monotonicElapsed)));
    };
    writeDeviceSession({ ...session, renewalStartedAt: startedAt });
    const generation = deviceSessionGeneration();
    const epoch = readSignInEpoch();
    const ownsFile = () => readDeviceSession()?.token === session.token;
    const current = () => generation === deviceSessionGeneration() && readDeviceSession()?.token === session.token
      && epoch === readSignInEpoch() && readAuthSignedOutAt() === null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      const budget = remaining();
      if (budget <= 0 || !current()) break;
      try {
        const response = await requestDeviceService('renew', session.token, { installId: session.installId }, AbortSignal.timeout(budget));
        if (remaining() <= 0) break;
        if (response.status === 401 || response.status === 403) {
          if (ownsFile()) deleteDeviceSession();
          return fail(response.status === 401 ? 'device_invalid' : 'account_blocked', response.status);
        }
        if (!response.ok) continue;
        const data = await response.json();
        if (remaining() <= 0) break;
        if (!data || !validDeviceGrant(data) || typeof data.ticket !== 'string' || !data.ticket.trim()) continue;
        if (!current() || data.clerkUserId !== session.clerkUserId) {
          // Epoch changes invalidate activation, not ownership of the old file.
          let directRevoke = false;
          try {
            // A freshly returned grant is certainly current inside this budget.
            try { queueDeviceRevoke(data.deviceToken); } catch { directRevoke = true; }
          } finally {
            if (ownsFile()) deleteDeviceSession();
          }
          if (directRevoke) await requestDeviceService('revoke', data.deviceToken).catch(() => {});
          else await retryPendingDeviceRevokes();
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
    // Revoke also performs reuse detection. An unconfirmed token must never be
    // sent there, including after restart or a clock correction.
    try { removePendingDeviceRevoke(session.token); } finally {
      if (ownsFile()) deleteDeviceSession();
    }
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
