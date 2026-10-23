// payer policy part c: preserve the detached supervisor's existing launch until it resolves keys by reference.
import { spawn } from 'node:child_process';
import { PROVIDER_ENV_KEYS, resolveProviderKey } from '@/lib/providers/key-store';

export const spawnSolo = spawn;
export function soloEnvironment(overrides: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...overrides };
  // Keep saved-key availability on the deferred Solo path. Ordinary runtime
  // launches resolve their own persisted billing policy instead.
  for (const name of PROVIDER_ENV_KEYS) {
    const value = resolveProviderKey(name);
    if (value) env[name] = value;
    else delete env[name];
  }
  return env;
}
