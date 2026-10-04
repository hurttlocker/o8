import { mintPluginToken, PLUGIN_FOLLOW_UP_SCOPE, PLUGIN_READ_SCOPE } from '@/lib/auth/plugin-token';
import type { HttpReqFrame } from '@/lib/mobile/relay-connector-protocol';

export interface PluginRelayGrant {
  clientId: string;
  scopes: string[];
  expiresAt: number;
}

export function parsePluginRelayGrant(value: unknown): PluginRelayGrant | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const grant = value as PluginRelayGrant;
  return typeof grant.clientId === 'string' && grant.clientId.length > 0 && grant.clientId.length <= 256
    && Array.isArray(grant.scopes) && grant.scopes.length <= 2
    && grant.scopes.every((scope) => scope === PLUGIN_READ_SCOPE || scope === PLUGIN_FOLLOW_UP_SCOPE)
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
    return `Bearer ${mintPluginToken({ machineId, clientId: grant.clientId, scopes: grant.scopes })}`;
  } catch {
    return null;
  }
}
