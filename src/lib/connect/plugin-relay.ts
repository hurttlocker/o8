import { mintPluginToken, PLUGIN_FOLLOW_UP_SCOPE, PLUGIN_READ_SCOPE, PLUGIN_PREPARE_TASK_SCOPE, PLUGIN_LAUNCH_TASK_SCOPE } from '@/lib/auth/plugin-token';
import type { HttpReqFrame } from '@/lib/mobile/relay-connector-protocol';

export interface PluginRelayGrant {
  clientId: string;
  scopes: string[];
  expiresAt: number;
  accountId?: string;
}

export function parsePluginRelayGrant(value: unknown): PluginRelayGrant | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const grant = value as PluginRelayGrant;
  return typeof grant.clientId === 'string' && grant.clientId.length > 0 && grant.clientId.length <= 256
    && Array.isArray(grant.scopes) && grant.scopes.length <= 4
    && grant.scopes.every((scope) => scope === PLUGIN_READ_SCOPE || scope === PLUGIN_FOLLOW_UP_SCOPE || scope === PLUGIN_PREPARE_TASK_SCOPE || scope === PLUGIN_LAUNCH_TASK_SCOPE)
    && (grant.accountId === undefined || (typeof grant.accountId === 'string' && /^user_[A-Za-z0-9_-]{1,240}$/.test(grant.accountId)))
    && (!grant.scopes.some((scope) => scope === PLUGIN_PREPARE_TASK_SCOPE || scope === PLUGIN_LAUNCH_TASK_SCOPE) || Boolean(grant.accountId))
    && Number.isFinite(grant.expiresAt) && grant.expiresAt > Date.now()
    ? grant : null;
}

/** A plugin stream has one fixed destination and never acquires an operator bearer. */
export function pluginReplayAuthorization(
  machineId: string,
  grant: PluginRelayGrant,
  request: HttpReqFrame,
): string | null {
  if (request.path !== '/api/plugins/mcp' || request.method !== 'POST' || grant.expiresAt <= Date.now()) return null;
  try {
    return `Bearer ${mintPluginToken({ machineId, clientId: grant.clientId, scopes: grant.scopes, accountId: grant.accountId }, { expiresAt: grant.expiresAt })}`;
  } catch {
    return null;
  }
}
