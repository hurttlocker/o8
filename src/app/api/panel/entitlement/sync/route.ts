import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';

import { proxyBaseUrl } from '@/lib/cortex/qa/llm/inference-route';
import { getOrCreateInstallId } from '@/lib/entitlement/bootstrap';
import { clearFounderRecord, writeFounderRecord } from '@/lib/entitlement/founder';
import { verifyLicense, writeCachedEntitlement } from '@/lib/entitlement/license';
import { getEntitlement } from '@/lib/entitlement/store';

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
    if (!sessionToken) return NextResponse.json({ ok: false, reason: 'no_session' }, { status: 401 });

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

    const res = await fetch(`${proxyBaseUrl()}/account/license`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${sessionToken}` },
    });

    // Signed in but no paid entitlement on this account — fine; the free-token
    // path covers them. Clear any stale founder badge and report success.
    if (res.status === 404) {
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

    const wrote = writeCachedEntitlement({
      plan: verified.plan,
      status: 'active',
      expiresAt: verified.expiresAt,
      licenseKey: license,
    });
    if (!wrote) return NextResponse.json({ ok: false, reason: 'failed_to_persist' });

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
