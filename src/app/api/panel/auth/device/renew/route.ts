import { accountRefreshIsBlocked, currentAccountGeneration, readAccountState, requireAccountGeneration, withPreservedAccountState } from '@/lib/auth/account-state';
import { performance } from 'node:perf_hooks';
import { deviceRequestIsLocal, deviceResponse, requestDeviceService, retryPendingDeviceRevokes, validDeviceGrant } from '@/lib/auth/device-session-service';
import { deleteDeviceSession, deviceSessionGeneration, queueDeviceRevoke, readDeviceSession, readUsableDeviceSession, removePendingDeviceRevoke, writeDeviceSession } from '@/lib/auth/device-session-store';
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
    const initial = await withPreservedAccountState(() => {
      const generation = currentAccountGeneration();
      const session = readUsableDeviceSession();
      if (accountRefreshIsBlocked() || readAuthSignedOutAt() !== null) {
        try { if (session?.renewalStartedAt !== undefined) removePendingDeviceRevoke(session.token); }
        finally { deleteDeviceSession(); }
        return { session: null, generation, failure: fail('signed_out', 401) };
      }
      if (!session) return { session: null, generation, failure: fail('no_device', 401) };
      if (session.renewalStartedAt !== undefined) {
        try { removePendingDeviceRevoke(session.token); } finally { deleteDeviceSession(); }
        return { session: null, generation, failure: fail('device_uncertain', 401) };
      }
      return { session, generation, failure: null };
    });
    if (!initial.session) return initial.failure!;
    const session = initial.session;
    const startedAt = Date.now();
    const monotonicStart = performance.now();
    const remaining = () => {
      const wallElapsed = Date.now() - startedAt;
      const monotonicElapsed = performance.now() - monotonicStart;
      if (!Number.isFinite(wallElapsed) || !Number.isFinite(monotonicElapsed)
        || wallElapsed < 0 || monotonicElapsed < 0) return 0;
      return Math.max(0, Math.ceil(RECOVERY_MS - Math.max(wallElapsed, monotonicElapsed)));
    };
    const captured = await withPreservedAccountState(() => {
      try { requireAccountGeneration(initial.generation); } catch { return null; }
      if (readDeviceSession()?.token !== session.token || readDeviceSession()?.renewalStartedAt !== undefined || accountRefreshIsBlocked() || readAuthSignedOutAt() !== null) return null;
      writeDeviceSession({ ...session, renewalStartedAt: startedAt });
      return { accountGeneration: currentAccountGeneration(), generation: deviceSessionGeneration(), epoch: readSignInEpoch() };
    });
    if (!captured) return fail('device_state_changed', 409);
    const current = () => captured.accountGeneration === readAccountState()?.generation && captured.generation === deviceSessionGeneration() && readDeviceSession()?.token === session.token
      && captured.epoch === readSignInEpoch() && !accountRefreshIsBlocked() && readAuthSignedOutAt() === null;
    const retire = () => withPreservedAccountState(() => {
      // An epoch change cancels activation, but this invocation can retire its
      // exact still-owned uncertainty record. Never remove a replacement grant.
      const actual = readDeviceSession();
      if (actual?.token !== session.token || actual.clerkUserId !== session.clerkUserId
        || actual.installId !== session.installId || actual.renewalStartedAt !== startedAt) return;
      try { removePendingDeviceRevoke(session.token); } finally { deleteDeviceSession(); }
    });
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      const budget = remaining();
      if (budget <= 0 || !current()) break;
      try {
        const response = await requestDeviceService('renew', session.token, { installId: session.installId }, AbortSignal.timeout(budget));
        if (remaining() <= 0) break;
        if (response.status === 401 || response.status === 403) {
          await retire();
          return fail(response.status === 401 ? 'device_invalid' : 'account_blocked', response.status);
        }
        if (!response.ok) continue;
        const data = await response.json();
        if (remaining() <= 0) break;
        if (!data || !validDeviceGrant(data) || typeof data.ticket !== 'string' || !data.ticket.trim()) continue;
        const accepted = await withPreservedAccountState(() => {
          try { requireAccountGeneration(captured.accountGeneration); } catch { return false; }
          if (!current() || data.clerkUserId !== session.clerkUserId) return false;
          writeDeviceSession({ token: data.deviceToken, clerkUserId: session.clerkUserId,
            installId: session.installId, idleExpiresAt: data.idleExpiresAt });
          return true;
        });
        if (!accepted) {
          // Epoch changes invalidate activation, not ownership of the old file.
          let directRevoke = false;
          try {
            // A freshly returned grant is certainly current inside this budget.
            try { queueDeviceRevoke(data.deviceToken); } catch { directRevoke = true; }
          } finally {
            await retire();
          }
          if (directRevoke) await requestDeviceService('revoke', data.deviceToken).catch(() => {});
          else await retryPendingDeviceRevokes();
          return fail(data.clerkUserId !== session.clerkUserId ? 'device_owner_mismatch' : 'device_state_changed', 409);
        }
        // Drop the uncertainty timestamp only after persisting the rotated token.
        return { status: 200, body: { ticket: data.ticket, clerkUserId: session.clerkUserId } };
      } catch {
        // The request may already have rotated upstream. Retry inside grace.
      }
    }
    // Revoke also performs reuse detection. An unconfirmed token must never be
    // sent there, including after restart or a clock correction.
    await retire();
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
