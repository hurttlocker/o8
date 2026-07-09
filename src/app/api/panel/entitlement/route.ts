import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { rm } from 'node:fs/promises';

import { resolveFlags } from '@/lib/entitlement/flags';
import { clearFounderRecord, readFounderRecord } from '@/lib/entitlement/founder';
import { readCachedEntitlement, verifyLicense, writeCachedEntitlement } from '@/lib/entitlement/license';
import { getEntitlement, getEntitlementPath } from '@/lib/entitlement/store';

export const dynamic = 'force-dynamic';

/**
 * GET /api/panel/entitlement — returns the resolved { plan, flags, source }.
 * Already loopback+token gated via GATED_PREFIXES ('/api/panel/') in
 * src/middleware.ts. Never throws (repo rule): falls back to free on any error.
 */
export async function GET(request: Request) {
  try {
    let activeSubject: string | null = null;
    try {
      activeSubject = (await auth()).userId;
    } catch {
      activeSubject = null;
    }
    // Native-mode fallback (#1483): auth() reads cookies, but the desktop Clerk
    // session lives in the Tauri store, so cookies carry no user. The client
    // (EntitlementProvider) forwards the clerk-js-known subject as ?subject= so a
    // GENUINE cross-user mismatch still drops. Absent/loading → null → keep (the
    // guard never drops on unknown). This is loopback+token gated, and the worst
    // a wrong subject can do is wipe the caller's own cache (reversible re-sync).
    if (!activeSubject) {
      try {
        activeSubject = new URL(request.url).searchParams.get('subject')?.trim() || null;
      } catch {
        activeSubject = null;
      }
    }
    readCachedEntitlement({ activeSubject });
    const entitlement = await getEntitlement();
    // founder is cosmetic display metadata (Founding Operator #N) — null for
    // everyone who isn't a founder. The signed plan above is the real gate.
    const actualFounder = readFounderRecord();
    // View-as (#1517): when the dev override is downclamping the plan, present
    // the EFFECTIVE view so every consumer that reads `plan`/`flags`/`founder`
    // (settings gates, canvas glass, use-founder-status) sees the free
    // experience with no per-callsite change. The real state stays available on
    // `actualPlan` + `actualFounder` for the management/dev-switch surfaces.
    const founder = entitlement.overrideActive ? null : actualFounder;
    return NextResponse.json({ ...entitlement, founder, actualFounder });
  } catch (error) {
    console.error('[entitlement] route failed:', error);
    return NextResponse.json({
      plan: 'free',
      flags: resolveFlags('free'),
      source: 'default',
      actualPlan: 'free',
      overrideActive: false,
      founder: null,
      actualFounder: null,
    });
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
      clearFounderRecord();
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
