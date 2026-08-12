import {
  correlatedActionIsUnsettled,
  fetchCorrelatedActionReceipt,
} from '@/lib/orchestrator/action-receipt';

/**
 * Client-side helpers for the four common post-dispatch packet actions.
 * Both retry and reset hit the same server endpoint — the server handler
 * `reset_packet` is aliased to `retry_packet` in operator-mcp-server.ts.
 * `clearWorktree` is the only behavioural differentiator between the two.
 */

export interface PacketActionResult {
  ok: boolean;
  note?: string;
  salvaged?: boolean;
  /** The exact mutation receipt is still unresolved; callers must stay latched. */
  unsettled?: boolean;
}

function responseMessage(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const message = (value as Record<string, unknown>).message;
  return typeof message === 'string' ? message.trim() || undefined : undefined;
}

async function postReset(body: Record<string, unknown>): Promise<PacketActionResult> {
  const requestBody = JSON.stringify({ ...body, idempotencyKey: crypto.randomUUID() });
  try {
    const { response: res, payload: data } = await fetchCorrelatedActionReceipt<{
      ok?: boolean;
      note?: unknown;
      error?: unknown;
      result?: Record<string, unknown>;
    }>('/api/orchestrator/reset-packet', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: requestBody,
    });
    if (!res.ok) {
      return {
        ok: false,
        note: responseMessage(data?.error) ?? responseMessage(data?.note) ?? `HTTP ${res.status}`,
      };
    }
    const salvaged = data?.result?.salvaged === true;
    return {
      ok: true,
      note: responseMessage(data?.result?.note) ?? responseMessage(data?.note),
      ...(salvaged ? { salvaged: true } : {}),
    };
  } catch (error) {
    if (correlatedActionIsUnsettled(error)) {
      return { ok: false, note: error.message, unsettled: true };
    }
    const message = error instanceof Error ? error.message : 'Network error';
    return { ok: false, note: message };
  }
}

export function callRetryPacket(packetId: string, reason?: string): Promise<PacketActionResult> {
  return postReset({ packetId, reason: reason ?? 'operator retry', clearWorktree: false });
}

export function callResetPacket(packetId: string, reason?: string): Promise<PacketActionResult> {
  return postReset({ packetId, reason: reason ?? 'operator reset', clearWorktree: true });
}
