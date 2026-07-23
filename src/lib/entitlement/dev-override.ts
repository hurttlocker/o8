import 'server-only';

import { readFileSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { Plan } from './types';
import { getDataDir } from '@/lib/data-dir-migration';

/**
 * Dev "View as Free" override (#1517) — a machine-local switch that lets the
 * operator preview a DOWNGRADED plan experience without touching their real
 * license.
 *
 * TWO OVERRIDE MECHANISMS, DIFFERENT TRUST MODELS — do not conflate:
 *   - env `O8_PLAN`  = RAW dev override (trusted local dev). Whatever you set is
 *     the resolved plan, no clamp. It's an environment variable a developer
 *     controls; it can raise OR lower the plan. (store.ts, precedence #1.)
 *   - file `~/.o8/dev-plan-override` = the VIEW-AS switch. It is MIN-CLAMPED:
 *     the effective plan is `min(realPlan, overridePlan)`, so it can only ever
 *     DOWNGRADE. A free user who somehow writes `{plan:'founder'}` still sees
 *     free. This is the security invariant — the clamp lives in store.ts's
 *     resolver, and this file only stores/reads the override + owns the pure
 *     `clampPlan` helper.
 *
 * The override NEVER writes entitlement.json / founder.json — the real license
 * (and its `licenseKey`) stays on disk untouched, so clearing the override
 * instantly restores the paid experience and no token is ever minted or wiped.
 * ENOENT-tolerant (a missing file is the common "not overriding" case). Never
 * throws.
 */

const OVERRIDE_FILE = 'dev-plan-override';
const VALID_PLANS: readonly Plan[] = ['free', 'pro', 'team', 'founder'];

/**
 * Plan strength ordering. `clampPlan` returns the weaker (lower-ranked) of the
 * two, which is the whole security guarantee: an override can lower the plan but
 * never raise it. team/founder are both "top paid" but kept distinct so a
 * founder→team downgrade (or any partial downgrade) is still expressible.
 */
export const PLAN_RANK: Record<Plan, number> = {
  free: 0,
  pro: 1,
  team: 2,
  founder: 3,
};

/**
 * The effective plan = min(actual, override). Pure — no I/O. When `override` is
 * null (no view-as file) the real plan passes through unchanged. When set, the
 * WEAKER plan wins, so the override can only ever DOWNGRADE. This is the single
 * security chokepoint the whole feature leans on.
 */
export function clampPlan(actual: Plan, override: Plan | null): Plan {
  if (!override) return actual;
  return PLAN_RANK[override] < PLAN_RANK[actual] ? override : actual;
}

// Same data-dir resolution store.ts + founder.ts use — so a temp
// CORTEX_IDE_DATA_DIR in tests points every entitlement file at one place.
export function getDevOverridePath() {
  return path.join(
    getDataDir(),
    OVERRIDE_FILE,
  );
}

interface DevOverrideFile {
  plan?: unknown;
  setAt?: unknown;
}

function coercePlan(value: unknown): Plan | null {
  return typeof value === 'string' && (VALID_PLANS as readonly string[]).includes(value)
    ? (value as Plan)
    : null;
}

function isMissingFile(error: unknown) {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function parseOverridePlan(raw: string): Plan | null {
  return coercePlan((JSON.parse(raw) as DevOverrideFile).plan);
}

/** Sync read of the override plan (or null). Feeds `getEntitlementSync`. */
export function readDevPlanOverrideSync(): Plan | null {
  try {
    return parseOverridePlan(readFileSync(getDevOverridePath(), 'utf8'));
  } catch (error) {
    if (!isMissingFile(error)) {
      console.error('[entitlement] Failed to read dev-plan-override:', error);
    }
    return null;
  }
}

/** Async read of the override plan (or null). Feeds `getEntitlement`. */
export async function readDevPlanOverride(): Promise<Plan | null> {
  try {
    return parseOverridePlan(await readFile(getDevOverridePath(), 'utf8'));
  } catch (error) {
    if (!isMissingFile(error)) {
      console.error('[entitlement] Failed to read dev-plan-override:', error);
    }
    return null;
  }
}

export interface DevOverrideState {
  /** The overridden plan the view-as switch is pinned to, or null when off. */
  plan: Plan | null;
  /** ISO timestamp the override was set, when known. */
  setAt: string | null;
}

/** Full override record for the API surface (plan + setAt). Never throws. */
export function readDevOverrideStateSync(): DevOverrideState {
  try {
    const parsed = JSON.parse(readFileSync(getDevOverridePath(), 'utf8')) as DevOverrideFile;
    const plan = coercePlan(parsed.plan);
    return { plan, setAt: typeof parsed.setAt === 'string' ? parsed.setAt : null };
  } catch (error) {
    if (!isMissingFile(error)) {
      console.error('[entitlement] Failed to read dev-plan-override state:', error);
    }
    return { plan: null, setAt: null };
  }
}

/** Persist the view-as override. Caller is responsible for the downgrade + gate checks. */
export async function writeDevPlanOverride(plan: Plan): Promise<void> {
  const filePath = getDevOverridePath();
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(
    filePath,
    `${JSON.stringify({ plan, setAt: new Date().toISOString() }, null, 2)}\n`,
    { mode: 0o600 },
  );
}

/** Remove the override (revert to the real plan). force:true → missing is a no-op. */
export async function clearDevPlanOverride(): Promise<void> {
  await rm(getDevOverridePath(), { force: true });
}
