import { parseKeyEnv } from './env-format';
import { PROVIDER_ENV_KEYS, PROVIDER_KEY_ALIASES } from './key-store';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';
import { runtimeBillingMode } from './runtime-billing';
import { providerCredentialName } from './spawn-environment';

/** Includes native file changes, so process reuse cannot bypass a cold-start decision. */
export function credentialPolicyFingerprint(runtimeId: string): string {
  let store: string;
  try { store = readFileSync(join(getDataDir(), '.env.local'), 'utf8'); }
  catch { store = 'unavailable'; }
  const values = parseKeyEnv(store);
  const managed = new Set<string>();
  for (const name of PROVIDER_ENV_KEYS) if (values.get(`O8_KEY_MANAGED_${name}`) === '1' || values.has(name)) {
    managed.add(name); for (const alias of PROVIDER_KEY_ALIASES[name] ?? []) managed.add(alias);
  }
  return createHash('sha256').update(JSON.stringify([runtimeBillingMode(runtimeId), store,
    Object.entries(process.env).filter(([name]) => providerCredentialName(name) && !managed.has(name)).sort()])).digest('hex');
}
