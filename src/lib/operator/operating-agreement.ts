import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';

/** Optional owner-authored instructions; never seeded by the app. Read every turn. */
export function withOperatingAgreement(message: string): string {
  const path = join(getDataDir(), 'OPERATING_AGREEMENT.md');
  let text: string;
  try {
    if (statSync(path).size > 32_768) throw new Error('Operating agreement exceeds 32 KiB. Shorten it before starting work.');
    text = readFileSync(path, 'utf8').trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return message;
    throw error;
  }
  if (!text) return message;
  const block = `[Owner operating agreement]\nApply these local preferences before work, alongside the current request and repository rules.\n${text}\n[End owner operating agreement]`;
  return message.includes(block) ? message : `${block}\n\n${message}`;
}
