import 'server-only';

import { readFileSync } from 'node:fs';
import { mutateAccountState } from '@/lib/auth/account-state';
import { removeAccountFile, writeAccountFile } from '@/lib/auth/account-state-files';
import path from 'node:path';

import type { FounderInfo } from './types';
import { getDataDir } from '@/lib/data-dir-migration';

/**
 * Pro · Lifetime local record (`founder.json`, retained for compatibility).
 *
 * Written by the entitlement sync route when the license server reports a
 * `founding` source, cleared otherwise. PURELY cosmetic — the actual
 * entitlement is the signed `founder` plan in entitlement.json; this only powers
 * the lifetime badge serial and legacy metadata. Mirrors license.ts's cache
 * style (mode 0600, ENOENT-tolerant, never throws).
 */

export interface FounderRecord extends FounderInfo {
  /** ISO timestamp of the last successful account sync that set this. */
  syncedAt: string;
}

function founderPath(): string {
  return path.join(
    getDataDir(),
    'founder.json',
  );
}

export function readFounderRecord(): FounderRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(founderPath(), 'utf8')) as Partial<FounderRecord>;
    if (typeof parsed.operatorNumber !== 'number') return null;
    return {
      operatorNumber: parsed.operatorNumber,
      tier: typeof parsed.tier === 'number' ? parsed.tier : null,
      syncedAt: typeof parsed.syncedAt === 'string' ? parsed.syncedAt : '',
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error('[founder] failed to read founder.json:', error);
    }
    return null;
  }
}

export function writeFounderRecord(rec: FounderRecord): boolean {
  try {
    const filePath = founderPath();
    mutateAccountState(() => writeAccountFile(filePath, `${JSON.stringify(rec, null, 2)}\n`));
    return true;
  } catch (error) {
    console.error('[founder] failed to write founder.json:', error);
    return false;
  }
}

export function clearFounderRecord(): void {
  mutateAccountState(() => removeAccountFile(founderPath()));
}
