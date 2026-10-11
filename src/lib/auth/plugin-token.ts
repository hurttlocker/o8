import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { getDataDir } from '@/lib/data-dir-migration';

export const PLUGIN_READ_SCOPE = 'o8:read';
export const PLUGIN_FOLLOW_UP_SCOPE = 'o8:follow-up';
// Preparing a held draft conveys no worker execution authority.
export const PLUGIN_PREPARE_TASK_SCOPE = 'o8:prepare-task';
// Separate consent for the bounded hosted launch and Stop capability.
export const PLUGIN_LAUNCH_TASK_SCOPE = 'o8:launch-task';
const PREFIX = 'o8p_';
const MAX_LIFETIME_MS = 60_000;

export interface PluginPrincipal {
  role: 'plugin';
  machineId: string;
  clientId: string;
  scopes: string[];
  surface: 'chatgpt';
  expiresAt: number;
  accountId?: string;
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
  input: Pick<PluginPrincipal, 'machineId' | 'clientId' | 'scopes' | 'accountId'>,
  options: { dataDir?: string; now?: number; expiresAt?: number } = {},
): string {
  if (!input.machineId || !input.clientId || !input.scopes.every((scope) =>
    scope === PLUGIN_READ_SCOPE || scope === PLUGIN_FOLLOW_UP_SCOPE || scope === PLUGIN_PREPARE_TASK_SCOPE || scope === PLUGIN_LAUNCH_TASK_SCOPE)
    || (input.accountId !== undefined && !validAccountId(input.accountId))
    || (input.scopes.some((scope) => scope === PLUGIN_PREPARE_TASK_SCOPE || scope === PLUGIN_LAUNCH_TASK_SCOPE) && !validAccountId(input.accountId))) {
    throw new Error('Invalid plugin grant.');
  }
  const key = signingKey(options.dataDir ?? getDataDir(), true);
  if (!key) throw new Error('Plugin credential store unavailable.');
  const now = options.now ?? Date.now();
  const expiresAt = Math.min(now + MAX_LIFETIME_MS, options.expiresAt ?? Infinity);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) throw new Error('Expired plugin grant.');
  const claims: PluginPrincipal = {
    ...input, role: 'plugin', surface: 'chatgpt',
    expiresAt,
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
        scope === PLUGIN_READ_SCOPE || scope === PLUGIN_FOLLOW_UP_SCOPE || scope === PLUGIN_PREPARE_TASK_SCOPE || scope === PLUGIN_LAUNCH_TASK_SCOPE)
      && (value.accountId === undefined || validAccountId(value.accountId))
      && (!value.scopes.some((scope) => scope === PLUGIN_PREPARE_TASK_SCOPE || scope === PLUGIN_LAUNCH_TASK_SCOPE) || validAccountId(value.accountId))
      && Number.isFinite(value.expiresAt) && value.expiresAt > now
      && value.expiresAt <= now + MAX_LIFETIME_MS
      ? value : null;
  } catch {
    return null;
  }
}

function validAccountId(value: unknown): value is string {
  return typeof value === 'string' && /^user_[A-Za-z0-9_-]{1,240}$/.test(value);
}
