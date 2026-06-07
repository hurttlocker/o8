import 'server-only';

import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { resolveFlags } from './flags';
import type { EntitlementState, Plan } from './types';

/**
 * Entitlement reader — resolves the active plan with env > file > default
 * precedence, modeled on src/lib/worker/feature-flags.ts. ENOENT-tolerant
 * (a missing file is the common free case, not an error). Never throws.
 *
 * The license/Stripe path (M4/M5) writes the file; M1 only reads it.
 */

const ENTITLEMENT_FILE = 'entitlement.json';
const VALID_PLANS: readonly Plan[] = ['free', 'pro', 'team'];

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
    process.env.CORTEX_IDE_DATA_DIR || path.join(os.homedir(), '.o8'),
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

function toState(plan: Plan, source: EntitlementState['source']): EntitlementState {
  return { plan, flags: resolveFlags(plan), source };
}

export async function getEntitlement(): Promise<EntitlementState> {
  const envPlan = getEnvPlan();
  if (envPlan) return toState(envPlan, 'env');

  try {
    const raw = await readFile(getEntitlementPath(), 'utf8');
    const filePlan = readFilePlan(raw);
    if (filePlan) return toState(filePlan, 'file');
  } catch (error) {
    if (!isMissingFile(error)) {
      console.error('[entitlement] Failed to read entitlement:', error);
    }
  }

  return toState('free', 'default');
}

export function getEntitlementSync(): EntitlementState {
  const envPlan = getEnvPlan();
  if (envPlan) return toState(envPlan, 'env');

  try {
    const raw = readFileSync(getEntitlementPath(), 'utf8');
    const filePlan = readFilePlan(raw);
    if (filePlan) return toState(filePlan, 'file');
  } catch (error) {
    if (!isMissingFile(error)) {
      console.error('[entitlement] Failed to read entitlement during startup:', error);
    }
  }

  return toState('free', 'default');
}
