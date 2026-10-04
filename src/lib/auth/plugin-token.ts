import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { getDataDir } from '@/lib/data-dir-migration';

export const PLUGIN_READ_SCOPE = 'o8:read';
export const PLUGIN_FOLLOW_UP_SCOPE = 'o8:follow-up';
const PREFIX = 'o8p_';
const MAX_LIFETIME_MS = 60_000;

export interface PluginPrincipal {
  role: 'plugin';
  machineId: string;
  clientId: string;
  scopes: string[];
  surface: 'chatgpt';
  expiresAt: number;
}

function signingKey(dataDir: string, create: boolean): Buffer | null {
  const file = join(dataDir, 'plugin-token-key');
  try {
    const key = readFileSync(file);
    return key.length === 32 ? key : null;
  } catch {
    if (!create) return null;
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const key = randomBytes(32);
    try {
      writeFileSync(file, key, { flag: 'wx', mode: 0o600 });
      return key;
    } catch {
      return signingKey(dataDir, false);
    }
  }
}

/** A local, one-minute capability. The account OAuth token never reaches the app. */
export function mintPluginToken(
  input: Pick<PluginPrincipal, 'machineId' | 'clientId' | 'scopes'>,
  options: { dataDir?: string; now?: number } = {},
): string {
  if (!input.machineId || !input.clientId || !input.scopes.every((scope) =>
    scope === PLUGIN_READ_SCOPE || scope === PLUGIN_FOLLOW_UP_SCOPE)) {
    throw new Error('Invalid plugin grant.');
  }
  const key = signingKey(options.dataDir ?? getDataDir(), true);
  if (!key) throw new Error('Plugin credential store unavailable.');
  const claims: PluginPrincipal = {
    ...input, role: 'plugin', surface: 'chatgpt',
    expiresAt: (options.now ?? Date.now()) + MAX_LIFETIME_MS,
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = createHmac('sha256', key).update(payload).digest('base64url');
  return `${PREFIX}${payload}.${signature}`;
}

export function resolvePluginToken(
  token: string,
  options: { dataDir?: string; now?: number } = {},
): PluginPrincipal | null {
  if (!token.startsWith(PREFIX) || token.length > 4096) return null;
  const parts = token.slice(PREFIX.length).split('.');
  if (parts.length !== 2) return null;
  const key = signingKey(options.dataDir ?? getDataDir(), false);
  if (!key) return null;
  const signature = createHmac('sha256', key).update(parts[0]!).digest();
  const presented = Buffer.from(parts[1]!, 'base64url');
  if (signature.length !== presented.length || !timingSafeEqual(signature, presented)) return null;
  try {
    const value = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf8')) as PluginPrincipal;
    const now = options.now ?? Date.now();
    return value.role === 'plugin' && value.surface === 'chatgpt'
      && typeof value.machineId === 'string' && Boolean(value.machineId)
      && typeof value.clientId === 'string' && Boolean(value.clientId)
      && Array.isArray(value.scopes) && value.scopes.every((scope) =>
        scope === PLUGIN_READ_SCOPE || scope === PLUGIN_FOLLOW_UP_SCOPE)
      && Number.isFinite(value.expiresAt) && value.expiresAt > now
      && value.expiresAt <= now + MAX_LIFETIME_MS
      ? value : null;
  } catch {
    return null;
  }
}
