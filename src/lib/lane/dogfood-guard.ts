import 'server-only';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DOGFOOD_PR_ONLY_NOTE, type LaneMergePolicy } from '@/lib/lane/merge-mode';
import { getDataDir } from '@/lib/data-dir-migration';

/**
 * PR-only safety wall for the autonomous dogfood loop (#1173). While the loop is
 * driving it touches `~/.o8/.dogfood-pr-only`; every merge chokepoint refuses
 * while that sentinel exists — so "PR-only" is a mechanical WALL, not a prompt
 * line the loop is merely told to obey. Fail-safe by construction: present =
 * no merge. The human's normal app never creates it, so manual merges are
 * unaffected; the kill switch (dogfood-stop.sh) removes it on stop.
 */
export function dogfoodPrOnlyActive(): boolean {
  const dir = getDataDir();
  return existsSync(join(dir, '.dogfood-pr-only'));
}

export { DOGFOOD_PR_ONLY_NOTE };

export function currentLaneMergePolicy(): LaneMergePolicy {
  return dogfoodPrOnlyActive()
    ? { mode: 'pr_only', note: DOGFOOD_PR_ONLY_NOTE }
    : { mode: 'direct', note: null };
}
