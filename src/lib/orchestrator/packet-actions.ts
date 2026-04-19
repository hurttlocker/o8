/**
 * Client-side helpers for the four common post-dispatch packet actions.
 * Both retry and reset hit the same server endpoint — the server handler
 * `reset_packet` is aliased to `retry_packet` in operator-mcp-server.ts.
 * `clearWorktree` is the only behavioural differentiator between the two.
 */

export interface PacketActionResult {
  ok: boolean;
  note?: string;
}

async function postReset(body: Record<string, unknown>): Promise<PacketActionResult> {
  try {
    const res = await fetch('/api/orchestrator/reset-packet', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => null) as { note?: string; error?: string } | null;
    if (!res.ok) {
      return { ok: false, note: data?.error ?? data?.note ?? `HTTP ${res.status}` };
    }
    return { ok: true, note: data?.note };
  } catch (error) {
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
