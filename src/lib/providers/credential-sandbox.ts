import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';
import { ensureLaunchPolicy } from './launch-policy';
import { withProviderStoreLock } from './store-lock';

/** Only non-secret policy state and its native locking code enter worker sandboxes. */
export function credentialPolicySandbox(): { lockPath: string; readFiles: string[]; readDirectories: string[] } {
  return withProviderStoreLock(() => {
    const { policyFile } = ensureLaunchPolicy();
    const require = createRequire(import.meta.url);
    return {
      lockPath: join(realpathSync(getDataDir()), '.provider-keys.lock'),
      readFiles: [policyFile],
      readDirectories: ['better-sqlite3', 'bindings', 'file-uri-to-path'].map(name => realpathSync(dirname(require.resolve(`${name}/package.json`)))),
    };
  });
}
