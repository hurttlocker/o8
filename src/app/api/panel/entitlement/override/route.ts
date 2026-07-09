import { NextResponse } from 'next/server';

import {
  clampPlan,
  clearDevPlanOverride,
  readDevOverrideStateSync,
  writeDevPlanOverride,
} from '@/lib/entitlement/dev-override';
import { readFounderRecord } from '@/lib/entitlement/founder';
import { getEntitlement } from '@/lib/entitlement/store';
import type { Plan } from '@/lib/entitlement/types';

export const dynamic = 'force-dynamic';

/**
 * GET/POST /api/panel/entitlement/override — the dev "View as Free" switch (#1517).
 *
 * Already loopback+token gated via the '/api/panel/' prefix in src/middleware.ts
 * (default-deny; no allowlist entry, so this route stays gated). Never throws
 * (repo rule) — all errors are structured.
 *
 * SECURITY:
 *   - The override may only DOWNGRADE. POST-set is rejected unless the requested
 *     plan is <= the real plan (the same min-clamp the store enforces, checked
 *     here as defense-in-depth so a stale/hostile file can't even be written).
 *   - SET is restricted to Founding Operator #1 (Q ruling on #1517) — UI hiding
 *     is not a gate, so the route enforces it too. CLEAR is ALWAYS allowed so a
 *     machine can always escape a stuck view.
 *   - The override never touches entitlement.json / founder.json — the real
 *     license and its token stay on disk untouched.
 */

const VALID_PLANS: readonly Plan[] = ['free', 'pro', 'team', 'founder'];

async function currentState() {
  const entitlement = await getEntitlement();
  const override = readDevOverrideStateSync();
  return {
    active: entitlement.overrideActive,
    overridePlan: override.plan,
    setAt: override.setAt,
    actualPlan: entitlement.actualPlan,
    effectivePlan: entitlement.plan,
  };
}

export async function GET() {
  try {
    return NextResponse.json(await currentState());
  } catch (error) {
    console.error('[entitlement] override GET failed:', error);
    return NextResponse.json({
      active: false,
      overridePlan: null,
      setAt: null,
      actualPlan: 'free',
      effectivePlan: 'free',
    });
  }
}

interface OverridePostBody {
  plan?: unknown;
  clear?: unknown;
}

export async function POST(request: Request) {
  let body: OverridePostBody;
  try {
    body = (await request.json()) as OverridePostBody;
  } catch {
    return NextResponse.json({ ok: false, reason: 'invalid JSON body' });
  }

  // CLEAR is always allowed — the escape hatch. A machine must always be able to
  // leave the view-as mode regardless of who it is.
  if (body.clear === true) {
    try {
      await clearDevPlanOverride();
      return NextResponse.json(await currentState());
    } catch (error) {
      console.error('[entitlement] override clear failed:', error);
      return NextResponse.json({ ok: false, reason: 'failed to clear override' });
    }
  }

  const requested =
    typeof body.plan === 'string' && (VALID_PLANS as readonly string[]).includes(body.plan)
      ? (body.plan as Plan)
      : null;
  if (!requested) {
    return NextResponse.json({
      ok: false,
      reason: 'plan must be one of free | pro | team | founder, or pass clear:true',
    });
  }

  // GATE: only Founding Operator #1 may SET a view-as override (Q ruling #1517).
  // Free users must never get the opportunity. Enforced server-side — the
  // Settings control only hides it.
  const founder = readFounderRecord();
  if (!founder || founder.operatorNumber !== 1) {
    return NextResponse.json({
      ok: false,
      reason: 'view-as override is restricted to Founding Operator #1',
    });
  }

  // SECURITY: downgrade-only. clampPlan(real, requested) must equal `requested`,
  // i.e. requested is weaker-or-equal to the real plan; otherwise it's an
  // upgrade attempt and is rejected. (The store clamp would ignore it anyway;
  // this refuses to even persist it.)
  const entitlement = await getEntitlement();
  if (clampPlan(entitlement.actualPlan, requested) !== requested) {
    return NextResponse.json({
      ok: false,
      reason: 'override may only downgrade the effective plan',
    });
  }

  try {
    await writeDevPlanOverride(requested);
    return NextResponse.json(await currentState());
  } catch (error) {
    console.error('[entitlement] override set failed:', error);
    return NextResponse.json({ ok: false, reason: 'failed to persist override' });
  }
}
