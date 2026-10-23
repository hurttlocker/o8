import 'server-only';

import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';
import type { Plan } from './types';

/** Read-only compatibility for existing funded-service suppression.
 * Keep previously suppressed calls blocked until funded inference, voice, and
 * relay admission migrate. There is no edition simulation UI or writer API.
 */
const LEGACY_FILE = 'dev-plan-override';
const RANK: Record<Plan, number> = { free: 0, pro: 1, team: 2, founder: 3 };

export function clampServicePlan(actual: Plan, suppression: Plan | null): Plan {
  return suppression && RANK[suppression] < RANK[actual] ? suppression : actual;
}

function parse(raw: string): Plan | null {
  const value = (JSON.parse(raw) as { plan?: unknown }).plan;
  return typeof value === 'string' && Object.hasOwn(RANK, value) ? value as Plan : null;
}

function report(error: unknown) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
    console.error('[entitlement] Failed to read legacy service suppression:', error);
  }
}

export function readServiceSuppressionSync(): Plan | null {
  try {
    return parse(readFileSync(path.join(getDataDir(), LEGACY_FILE), 'utf8'));
  } catch (error) {
    report(error);
    return null;
  }
}

export async function readServiceSuppression(): Promise<Plan | null> {
  try {
    return parse(await readFile(path.join(getDataDir(), LEGACY_FILE), 'utf8'));
  } catch (error) {
    report(error);
    return null;
  }
}
