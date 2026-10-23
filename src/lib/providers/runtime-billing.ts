import { invalidateLaunchPolicy } from './launch-policy';
import { credentialPolicyChanged } from './policy-events';
import { withProviderStoreLock } from './store-lock';
import { purgeOwnedRuntimeArtifacts } from './owned-artifacts';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';

export type RuntimeBillingMode = 'subscription' | 'api';
const directory = () => join(getDataDir(), 'runtime-billing');
const validId = (id: string) => /^[a-z0-9][a-z0-9-]*$/.test(id);

/** Only an explicit persisted opt-in permits API credentials at a runtime boundary. */
export function runtimeBillingMode(runtimeId: string): RuntimeBillingMode {
  if (!validId(runtimeId) || runtimeId === 'codex') return 'subscription';
  try {
    return JSON.parse(readFileSync(join(directory(), `${runtimeId}.json`), 'utf8')).mode === 'api' ? 'api' : 'subscription';
  } catch { return 'subscription'; }
}

export function saveRuntimeBillingMode(runtimeId: string, mode: RuntimeBillingMode): void {
  if (!validId(runtimeId) || (mode !== 'api' && mode !== 'subscription')) throw new Error('Invalid runtime billing mode');
  if (runtimeId === 'codex' && mode === 'api') throw new Error('API billing for Codex is not available yet. See #4334.');
  withProviderStoreLock(() => {
    invalidateLaunchPolicy();
    purgeOwnedRuntimeArtifacts();
    mkdirSync(directory(), { recursive: true, mode: 0o700 });
    const target = join(directory(), `${runtimeId}.json`);
    const temporary = `${target}.${randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({ version: 1, mode })}\n`, { mode: 0o600, flag: 'wx' });
    renameSync(temporary, target);
  });
  credentialPolicyChanged();
}
