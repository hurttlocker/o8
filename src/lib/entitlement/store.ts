import 'server-only';

import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { clampServicePlan, readServiceSuppression, readServiceSuppressionSync } from './legacy-service-suppression';
import { resolveFlags } from './flags';
import type { EntitlementState, Plan } from './types';
import { getDataDir } from '@/lib/data-dir-migration';

/**
 * Entitlement reader — resolves the active plan with env > file > default
 * precedence, modeled on src/lib/worker/feature-flags.ts. ENOENT-tolerant
 * (a missing file is the common free case, not an error). Never throws.
 *
 * The optional hosted-license path writes the file. With no hosted service
 * configured, a missing file resolves directly to the open-build free plan.
 *
 * Existing local suppression stays read-only until funded services migrate.
 * The application no longer exposes edition simulation or override writers.
 */

const ENTITLEMENT_FILE = 'entitlement.json';
const VALID_PLANS: readonly Plan[] = ['free', 'pro', 'team', 'founder'];

interface EntitlementFile {
  plan?: unknown;
  licenseKey?: string;
  status?: string;
  expiresAt?: string;
}

// Canonical entitlement.json location (~/.o8 — same dir db/index.ts uses).
// Exported so license.ts writes the exact path store.ts reads — they MUST agree
// or a verified Pro license lands in a file the store never reads.
export function getEntitlementPath() {
  return path.join(
    getDataDir(),
    ENTITLEMENT_FILE,
  );
}

function coercePlan(value: unknown): Plan | null {
  return typeof value === 'string' && (VALID_PLANS as readonly string[]).includes(value)
    ? (value as Plan)
    : null;
}

function getEnvPlan(): Plan | null {
  return coercePlan(process.env.O8_PLAN);
}

function readFilePlan(raw: string): Plan | null {
  const parsed = JSON.parse(raw) as EntitlementFile;
  return coercePlan(parsed.plan);
}

function isMissingFile(error: unknown) {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function toState(
  realPlan: Plan,
  source: EntitlementState['source'],
  overridePlan: Plan | null,
): EntitlementState {
  const effective = clampServicePlan(realPlan, overridePlan);
  return {
    plan: effective,
    flags: resolveFlags(effective),
    source,
    actualPlan: realPlan,
    overrideActive: overridePlan !== null,
  };
}

export async function getEntitlement(): Promise<EntitlementState> {
  const overridePlan = await readServiceSuppression();
  const envPlan = getEnvPlan();
  if (envPlan) return toState(envPlan, 'env', overridePlan);

  try {
    const raw = await readFile(getEntitlementPath(), 'utf8');
    const filePlan = readFilePlan(raw);
    if (filePlan) return toState(filePlan, 'file', overridePlan);
  } catch (error) {
    if (!isMissingFile(error)) {
      console.error('[entitlement] Failed to read entitlement:', error);
    }
  }

  return toState('free', 'default', overridePlan);
}

export function getEntitlementSync(): EntitlementState {
  const overridePlan = readServiceSuppressionSync();
  const envPlan = getEnvPlan();
  if (envPlan) return toState(envPlan, 'env', overridePlan);

  try {
    const raw = readFileSync(getEntitlementPath(), 'utf8');
    const filePlan = readFilePlan(raw);
    if (filePlan) return toState(filePlan, 'file', overridePlan);
  } catch (error) {
    if (!isMissingFile(error)) {
      console.error('[entitlement] Failed to read entitlement during startup:', error);
    }
  }

  return toState('free', 'default', overridePlan);
}
