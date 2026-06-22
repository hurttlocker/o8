import { NextResponse } from 'next/server';
import { rm } from 'node:fs/promises';

import { resolveFlags } from '@/lib/entitlement/flags';
import { readFounderRecord } from '@/lib/entitlement/founder';
import { verifyLicense, writeCachedEntitlement } from '@/lib/entitlement/license';
import { getEntitlement, getEntitlementPath } from '@/lib/entitlement/store';

export const dynamic = 'force-dynamic';

/**
 * GET /api/panel/entitlement — returns the resolved { plan, flags, source }.
 * Already loopback+token gated via GATED_PREFIXES ('/api/panel/') in
 * src/middleware.ts. Never throws (repo rule): falls back to free on any error.
 */
export async function GET() {
  try {
    const entitlement = await getEntitlement();
    // founder is cosmetic display metadata (Founding Operator #N) — null for
    // everyone who isn't a founder. The signed plan above is the real gate.
    return NextResponse.json({ ...entitlement, founder: readFounderRecord() });
  } catch (error) {
    console.error('[entitlement] route failed:', error);
    return NextResponse.json({ plan: 'free', flags: resolveFlags('free'), source: 'default', founder: null });
  }
}

interface EntitlementPostBody {
  licenseKey?: unknown;
  clear?: unknown;
}

/**
 * POST /api/panel/entitlement — apply or clear a license key (M3).
 *
 * Body: { licenseKey?: string, clear?: boolean }
 *  - clear:true       → reset entitlement to free (remove entitlement.json).
 *  - licenseKey:<jwt> → verify via license.ts; on success persist the plan to
 *                       entitlement.json, on failure return { ok:false, reason }.
 *
 * On success returns the freshly-resolved { plan, flags, source } so the client
 * can update without a second GET. /api/panel/ is loopback+token gated in
 * src/middleware.ts. Never throws (repo rule) — all errors are structured.
 */
export async function POST(request: Request) {
  let body: EntitlementPostBody;
  try {
    body = (await request.json()) as EntitlementPostBody;
  } catch {
    return NextResponse.json({ ok: false, reason: 'invalid JSON body' });
  }

  // Clear → reset to free by removing the cache file. force:true makes a missing
  // file a no-op (the common case when already free).
  if (body.clear === true) {
    try {
      await rm(getEntitlementPath(), { force: true });
      const entitlement = await getEntitlement();
      return NextResponse.json(entitlement);
    } catch (error) {
      console.error('[entitlement] failed to clear entitlement:', error);
      return NextResponse.json({ ok: false, reason: 'failed to clear license' });
    }
  }

  const licenseKey = typeof body.licenseKey === 'string' ? body.licenseKey.trim() : '';
  if (!licenseKey) {
    return NextResponse.json({ ok: false, reason: 'no licenseKey or clear flag provided' });
  }

  const result = await verifyLicense(licenseKey);
  if (!result.valid || !result.plan) {
    return NextResponse.json({ ok: false, reason: result.reason ?? 'invalid license' });
  }

  const wrote = writeCachedEntitlement({
    plan: result.plan,
    status: 'active',
    expiresAt: result.expiresAt,
    licenseKey,
  });
  if (!wrote) {
    return NextResponse.json({ ok: false, reason: 'failed to persist license' });
  }

  const entitlement = await getEntitlement();
  return NextResponse.json(entitlement);
}
