import path from 'node:path';

import { getDataDir } from '@/lib/data-dir-migration';

export function dependencyCacheRoot(): string {
  return path.join(getDataDir(), 'package-manager-cache');
}
