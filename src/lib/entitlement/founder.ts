import 'server-only';

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { FounderInfo } from './types';
import { getDataDir } from '@/lib/data-dir-migration';

/**
 * Founding Operator local record (`~/.o8/founder.json`).
 *
 * Written by the entitlement sync route when the license server reports a
 * `founding` source, cleared otherwise. PURELY cosmetic — the actual
 * entitlement is the signed `pro` plan in entitlement.json; this only powers the
 * "Founding Operator #N" badge + the soft grant figures (which are finalized
 * separately). Mirrors license.ts's cache style (mode 0600, ENOENT-tolerant,
 * never throws).
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
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, `${JSON.stringify(rec, null, 2)}\n`, { mode: 0o600 });
    return true;
  } catch (error) {
    console.error('[founder] failed to write founder.json:', error);
    return false;
  }
}

export function clearFounderRecord(): void {
  try {
    rmSync(founderPath(), { force: true });
  } catch (error) {
    console.error('[founder] failed to clear founder.json:', error);
  }
}
