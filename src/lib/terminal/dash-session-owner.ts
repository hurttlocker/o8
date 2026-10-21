import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { getDataDir } from '@/lib/data-dir-migration';

export const DASH_PROFILE_OWNER_OPTION = '@o8-profile-owner';

/** Resolve aliases before hashing; an unresolvable profile has no cleanup authority. */
export function dashProfileOwnerId(dataDir = getDataDir()): string {
  return createHash('sha256').update(realpathSync(dataDir)).digest('hex').slice(0, 32);
}
