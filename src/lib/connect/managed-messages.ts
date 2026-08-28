import 'server-only';

import { proxyBaseUrl } from '@/lib/cortex/qa/llm/inference-route';

export interface ManagedMessageChannelStatus {
  enabled: boolean;
  phoneNumber: string | null;
  machineId: string | null;
  allowedSenderHandle: string | null;
}

export type ManagedMessageChannelResult =
  | { ok: true; data: ManagedMessageChannelStatus }
  | { ok: false; status: number; error: string };

async function channelRequest(
  method: 'GET' | 'PUT' | 'DELETE',
  token: string,
  machineId?: string,
  allowedSenderHandle?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ManagedMessageChannelResult> {
  try {
    const response = await fetchImpl(`${proxyBaseUrl().replace(/\/+$/, '')}/v1/managed-messages/channel`, {
      method,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        ...(machineId ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(machineId ? { body: JSON.stringify({ machineId, allowedSenderHandle }) } : {}),
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 204) {
      return {
        ok: true,
        data: {
          enabled: false,
          phoneNumber: null,
          machineId: null,
          allowedSenderHandle: null,
        },
      };
    }
    const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        error: typeof payload?.error === 'string' ? payload.error : 'managed_messages_unavailable',
      };
    }
    if (
      !payload
      || typeof payload.enabled !== 'boolean'
      || (payload.phoneNumber !== null && typeof payload.phoneNumber !== 'string')
      || (payload.machineId !== null && typeof payload.machineId !== 'string')
      || (payload.allowedSenderHandle !== null && typeof payload.allowedSenderHandle !== 'string')
    ) {
      return { ok: false, status: 502, error: 'invalid_response' };
    }
    return {
      ok: true,
      data: {
        enabled: payload.enabled,
        phoneNumber: payload.phoneNumber,
        machineId: payload.machineId,
        allowedSenderHandle: payload.allowedSenderHandle,
      },
    };
  } catch (error) {
    return {
      ok: false,
      status: 503,
      error: error instanceof Error ? error.message : 'managed_messages_unavailable',
    };
  }
}

export function getManagedMessageChannel(token: string): Promise<ManagedMessageChannelResult> {
  return channelRequest('GET', token);
}

export function enableManagedMessageChannel(
  token: string,
  machineId: string,
  allowedSenderHandle: string,
): Promise<ManagedMessageChannelResult> {
  return channelRequest('PUT', token, machineId, allowedSenderHandle);
}

export function disableManagedMessageChannel(token: string): Promise<ManagedMessageChannelResult> {
  return channelRequest('DELETE', token);
}
