import 'server-only';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * PR-only safety wall for the autonomous dogfood loop (#1173). While the loop is
 * driving it touches `~/.o8/.dogfood-pr-only`; every merge chokepoint refuses
 * while that sentinel exists — so "PR-only" is a mechanical WALL, not a prompt
 * line the loop is merely told to obey. Fail-safe by construction: present =
 * no merge. The human's normal app never creates it, so manual merges are
 * unaffected; the kill switch (dogfood-stop.sh) removes it on stop.
 */
export function dogfoodPrOnlyActive(): boolean {
  const dir = process.env.CORTEX_IDE_DATA_DIR || join(homedir(), '.o8');
  return existsSync(join(dir, '.dogfood-pr-only'));
}

export const DOGFOOD_PR_ONLY_NOTE =
  'PR-only dogfood mode is active — merge to main is blocked. Open a PR; a human merges.';
