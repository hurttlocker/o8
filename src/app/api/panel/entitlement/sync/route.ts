import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { proxyBaseUrl } from '@/lib/cortex/qa/llm/inference-route';
import { getOrCreateInstallId } from '@/lib/entitlement/bootstrap';
import { clearFounderRecord, writeFounderRecord } from '@/lib/entitlement/founder';
import { tokenIssuedAt } from '@/lib/entitlement/identity-guards';
import { clearCachedEntitlement, verifyLicense, writeCachedEntitlement } from '@/lib/entitlement/license';
import { getEntitlement } from '@/lib/entitlement/store';
import {
  bumpSignInEpoch,
  clearActiveIdentity,
  clearManagedGithubState,
  readManagedGithubState,
  readSignInEpoch,
  writeActiveIdentity,
  writeManagedGithubState,
} from '@/lib/github-broker/managed';

export const dynamic = 'force-dynamic';

const CLERK_ENABLED = Boolean(
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY || process.env.CLERK_PUBLISHABLE_KEY,
);

interface AccountLicenseResponse {
  license?: unknown;
  plan?: unknown;
  source?: unknown;
  founder?: { operatorNumber?: unknown; tier?: unknown };
}

interface SyncBody {
  signedOut?: unknown;
  clerkUserId?: unknown;
  /** Set by the desktop sign-in callback to retire the sign-out marker (#1483). */
  clearSignInMarker?: unknown;
}

function dataDir(): string {
  return process.env.CORTEX_IDE_DATA_DIR || path.join(os.homedir(), '.o8');
}

function signOutMarkerPath(): string {
  return path.join(dataDir(), 'auth-signed-out-at');
}

// The sign-out marker only guards the brief window between an explicit sign-out
// and the next sign-in: it stops a lingering pre-sign-out session token from
// silently re-applying a license. Past that window it has outlived its purpose.
// Without an upper bound a marker — which the client purge path itself re-stamps
// to "now" on every stale_session response — can keep rejecting freshly-issued
// session tokens whose iat lands just before it, auto-signing-out a legitimate
// user forever with zero action (#1483). Any marker older than this is ignored.
const SIGN_OUT_MARKER_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

/**
 * Refresh the managed GitHub App installation token from the license server.
 * 200 installed:true → persist token; 200 installed:false → persist the
 * install-CTA marker; 503 (feature off server-side) → clear. Network errors
 * leave existing state alone — a stale token self-expires within the hour.
 *
 * Identity is the SERVER-VERIFIED subject (`ownerClerkUserId`) — never the
 * client's claim (audit #2). That value:
 *   - REQUIRED: an old/omitting server (no field) means we can't safely bind, so
 *     we drop the write rather than trust a client-supplied owner (kills the
 *     rolling-deploy mis-stamp).
 *   - drives both the persisted owner AND the active-identity anchor the broker
 *     verifies against, so a client that lies about who is signed in can only
 *     ever fetch/serve ITS OWN token.
 *   - clears the prior user's token on an owner change (user switch).
 */
async function syncManagedGithubApp(sessionToken: string): Promise<void> {
  try {
    // Capture the sign-in generation BEFORE the round-trip. If a fresh sign-in
    // bumps it while we're in flight, this refresh is stale and must not write
    // (audit #2 single-process late-response race).
    const epochAtStart = readSignInEpoch();

    const res = await fetch(`${proxyBaseUrl()}/github/app/token`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${sessionToken}` },
    });
    if (res.status === 503) {
      if (readSignInEpoch() === epochAtStart) clearManagedGithubState();
      return;
    }
    if (!res.ok) return;
    const data = (await res.json()) as {
      installed?: boolean;
      token?: string;
      expiresAt?: string;
      installationId?: number;
      accountLogin?: string;
      installUrl?: string;
      ownerClerkUserId?: string;
    };

    // The verified subject is the ONLY identity we trust here. No client fallback.
    const owner = typeof data.ownerClerkUserId === 'string' ? data.ownerClerkUserId.trim() : '';
    if (!owner) return;

    // Staleness gate: a fresh sign-in during the round-trip means THIS refresh is
    // for a now-superseded session. Bail before touching any state — otherwise a
    // late B-refresh would clobber A's freshly-synced token (audit #2). Node's
    // single thread makes this check→write sequence atomic within the process.
    if (readSignInEpoch() !== epochAtStart) return;

    // Owner change on this desktop → drop the previous user's token immediately.
    const priorOwner = readManagedGithubState()?.ownerClerkUserId;
    if (priorOwner && priorOwner !== owner) clearManagedGithubState();

    // Anchor the active identity to the verified owner — this is what the broker
    // checks the token against on every read.
    writeActiveIdentity(owner);

    if (data.installed === true && data.token && data.expiresAt && data.installationId) {
      writeManagedGithubState({
        installed: true,
        token: data.token,
        expiresAt: data.expiresAt,
        installationId: data.installationId,
        accountLogin: data.accountLogin,
        ownerClerkUserId: owner,
      });
    } else if (data.installed === false) {
      writeManagedGithubState({ installed: false, installUrl: data.installUrl, ownerClerkUserId: owner });
    }
  } catch (error) {
    console.warn('[entitlement] managed GitHub App sync skipped:', error);
  }
}

function markSignedOut(): void {
  try {
    const filePath = signOutMarkerPath();
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, `${Math.floor(Date.now() / 1000)}\n`, { mode: 0o600 });
  } catch (error) {
    console.error('[entitlement] failed to mark sign-out:', error);
  }
}

function clearSignOutMarker(): void {
  try {
    rmSync(signOutMarkerPath(), { force: true });
  } catch (error) {
    console.error('[entitlement] failed to clear sign-out marker:', error);
  }
}

function readSignedOutAt(): number | null {
  try {
    const parsed = Number(readFileSync(signOutMarkerPath(), 'utf8').trim());
    if (!Number.isFinite(parsed) || parsed <= 0) return null;
    // Self-expire a stale marker so it can never purge a future session.
    if (Math.floor(Date.now() / 1000) - parsed > SIGN_OUT_MARKER_MAX_AGE_SECONDS) {
      clearSignOutMarker();
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

async function clearSignedOutEntitlement(reason: string, status = 200) {
  clearCachedEntitlement();
  clearFounderRecord();
  clearManagedGithubState();
  clearActiveIdentity();
  const entitlement = await getEntitlement();
  return NextResponse.json({ ok: false, reason, plan: entitlement.plan, source: 'none' }, { status });
}

/**
 * POST /api/panel/entitlement/sync — pull THIS signed-in user's license from the
 * license server and cache it locally, so a Founding Operator / subscriber lands
 * on the right plan (portable across machines, not tied to one install).
 *
 * Auth chain (no shared secret shipped in the app): we read the VERIFIED Clerk
 * session here (auth()), forward the user's short-lived Clerk session token to
 * the license server, which verifies it against the Clerk JWKS and returns the
 * license for THAT account only. On success we verifyLicense() the returned
 * token against the baked public key before writing entitlement.json — the same
 * trust path as a manually-applied key. Loopback+token gated via '/api/panel/'
 * in src/middleware.ts. Never throws (repo rule).
 */
export async function POST(request: Request) {
  if (!CLERK_ENABLED) return NextResponse.json({ ok: false, reason: 'clerk_disabled' });

  try {
    let body: SyncBody | null = null;
    try {
      body = (await request.json()) as SyncBody;
    } catch {
      body = null;
    }
    if (body?.signedOut === true) {
      markSignedOut();
      return clearSignedOutEntitlement('signed_out');
    }
    // Desktop sign-in just completed a fresh ticket exchange — retire the marker
    // deterministically so the follow-up license sync can't be rejected as
    // stale (#1483). Single-shot: fires on every real sign-in, independent of
    // the marker's own age or the incoming token's iat.
    if (body?.clearSignInMarker === true) {
      clearSignOutMarker();
      // A fresh sign-in must never inherit a prior user's managed GitHub token
      // (audit #2). Wipe it + the identity anchor now; the follow-up license
      // sync repopulates for the VERIFIED new user (or leaves nothing → the
      // broker fails closed). Cheap: the token is re-minted within the hour.
      // Bump the sign-in generation so any prior user's in-flight refresh that
      // completes after this point is detected as stale and dropped.
      bumpSignInEpoch();
      clearManagedGithubState();
      clearActiveIdentity();
      return NextResponse.json({ ok: true });
    }
    const activeClerkUserId = typeof body?.clerkUserId === 'string' ? body.clerkUserId.trim() : '';

    // Two session transports (live-hit 2026-07-05): web/cookie mode surfaces the
    // session to server-side auth(); the desktop NATIVE mode keeps it in the
    // Tauri store, so the client forwards its short-lived token in a header.
    // Either way the license server is the verifier (Clerk JWKS) — this route
    // never trusts the token itself, it only forwards it.
    let sessionToken: string | null = null;
    try {
      const { userId, getToken } = await auth();
      if (userId) sessionToken = await getToken();
    } catch {
      /* no cookie session — fall through to the native-mode header */
    }
    if (!sessionToken) {
      sessionToken = request.headers.get('x-clerk-session-token')?.trim() || null;
    }
    if (!sessionToken) return clearSignedOutEntitlement('no_session', 401);

    const signedOutAt = readSignedOutAt();
    const iat = tokenIssuedAt(sessionToken);
    if (signedOutAt !== null && iat !== null && iat < signedOutAt) {
      return clearSignedOutEntitlement('stale_session', 401);
    }

    // Best-effort: link this install to the signed-in account so a person's
    // devices + pre-sign-in usage roll into their ONE profile (beta analytics).
    // Fire-and-forget — never blocks or fails the license sync.
    try {
      const installId = getOrCreateInstallId();
      void fetch(`${proxyBaseUrl()}/account/link-install`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${sessionToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ installId }),
      }).catch(() => {});
    } catch {
      /* install id unavailable — skip linking, never block the sync */
    }

    // Managed GitHub App token — fetched alongside the license so the broker
    // can act as the public "o8" App without any local key. Best-effort and
    // fire-and-forget: GitHub features degrade to device-flow OAuth, never
    // block the license sync.
    //
    // Cross-account binding (audit #2): the sync resolves the SERVER-VERIFIED
    // owner and anchors identity to it — we deliberately do NOT seed identity
    // from the client-supplied activeClerkUserId (which is spoofable). Fresh
    // sign-in already wiped any prior user's token below, so the window between
    // sign-in and this refresh has no stale token to leak.
    void syncManagedGithubApp(sessionToken);

    const res = await fetch(`${proxyBaseUrl()}/account/license`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${sessionToken}` },
    });

    // Signed in but no paid entitlement on this account — fine; the free-token
    // path covers them. Clear any stale founder badge and report success.
    if (res.status === 404) {
      // A fresh authenticated session for this account is confirmed — the
      // sign-out marker has served its purpose (#1483).
      clearSignOutMarker();
      clearCachedEntitlement();
      clearFounderRecord();
      const entitlement = await getEntitlement();
      return NextResponse.json({ ok: true, plan: entitlement.plan, source: 'none' });
    }
    if (!res.ok) {
      return NextResponse.json({ ok: false, reason: `license_server_${res.status}` });
    }

    const data = (await res.json()) as AccountLicenseResponse;
    const license = typeof data.license === 'string' ? data.license : '';
    if (!license) return NextResponse.json({ ok: false, reason: 'no_license_in_response' });

    // Verify against the baked public key before trusting/caching (same as the
    // manual licenseKey path in /api/panel/entitlement).
    const verified = await verifyLicense(license);
    if (!verified.valid || !verified.plan) {
      return NextResponse.json({ ok: false, reason: verified.reason ?? 'invalid_license' });
    }
    if (!activeClerkUserId || verified.subject !== activeClerkUserId) {
      return clearSignedOutEntitlement('license_subject_mismatch', 409);
    }

    const postFetchSignedOutAt = readSignedOutAt();
    const postFetchIat = tokenIssuedAt(sessionToken);
    if (postFetchSignedOutAt !== null && postFetchIat !== null && postFetchIat < postFetchSignedOutAt) {
      return clearSignedOutEntitlement('stale_session', 401);
    }

    // Authoritative identity anchor from the VERIFIED license subject — a second
    // source alongside the managed-token sync (audit #2), so even if that
    // fire-and-forget refresh failed, the broker still binds the persisted token
    // to the right owner. verified.subject is confirmed non-null + == the caller
    // above, so this can only ever anchor to the genuine signed-in user.
    writeActiveIdentity(verified.subject);

    const wrote = writeCachedEntitlement({
      plan: verified.plan,
      status: 'active',
      expiresAt: verified.expiresAt,
      licenseKey: license,
    });
    if (!wrote) return NextResponse.json({ ok: false, reason: 'failed_to_persist' });

    // Verified, subject-matched license persisted for a fresh session — the
    // sign-out marker has served its purpose and must not linger to purge a
    // later reload (#1483).
    clearSignOutMarker();

    // Founding Operator → stamp the local badge record; otherwise clear it.
    const founder = data.founder;
    if (data.source === 'founding' && founder && typeof founder.operatorNumber === 'number') {
      writeFounderRecord({
        operatorNumber: founder.operatorNumber,
        tier: typeof founder.tier === 'number' ? founder.tier : null,
        syncedAt: new Date().toISOString(),
      });
    } else {
      clearFounderRecord();
    }

    const entitlement = await getEntitlement();
    return NextResponse.json({
      ok: true,
      plan: entitlement.plan,
      source: typeof data.source === 'string' ? data.source : 'subscription',
    });
  } catch (error) {
    console.error('[entitlement] sync failed:', error);
    return NextResponse.json({ ok: false, reason: 'error' });
  }
}
