import { credentialPolicyChanged } from './policy-events';
import { withProviderStoreLock } from './store-lock';
import { purgeOwnedMcpArtifacts } from './mcp-artifacts';
import 'server-only';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';

export type RuntimeBillingMode = 'subscription' | 'api';
const directory = () => join(getDataDir(), 'runtime-billing');
const validId = (id: string) => /^[a-z0-9][a-z0-9-]*$/.test(id);

/** Only an explicit persisted opt-in permits API credentials at a runtime boundary. */
export function runtimeBillingMode(runtimeId: string): RuntimeBillingMode {
  if (!validId(runtimeId)) return 'subscription';
  try {
    return JSON.parse(readFileSync(join(directory(), `${runtimeId}.json`), 'utf8')).mode === 'api' ? 'api' : 'subscription';
  } catch { return 'subscription'; }
}

export function saveRuntimeBillingMode(runtimeId: string, mode: RuntimeBillingMode): void {
  if (!validId(runtimeId) || (mode !== 'api' && mode !== 'subscription')) throw new Error('Invalid runtime billing mode');
  withProviderStoreLock(() => {
    purgeOwnedMcpArtifacts();
    mkdirSync(directory(), { recursive: true, mode: 0o700 });
    const target = join(directory(), `${runtimeId}.json`);
    const temporary = `${target}.${randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({ version: 1, mode })}\n`, { mode: 0o600, flag: 'wx' });
    renameSync(temporary, target);
  });
  credentialPolicyChanged();
}
