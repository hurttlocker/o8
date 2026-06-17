/**
 * emitProductEvent — server-side coarse telemetry (analytics epic #1249).
 *
 * The server twin of the client-side track() in ./track.ts. Reads THIS install's
 * account token from entitlement.json and forwards a coarse {event, props} to the
 * license server's /v1/telemetry. Used at server chokepoints the UI can't see —
 * the orchestrator dispatches packets and approves merges through MCP, never a
 * button — so this is the only place those product signals are observable at all.
 *
 * Fire-and-forget: never throws, never blocks. Callers on a hot path should NOT
 * await — use `void emitProductEvent(...)`. COARSE ONLY: an event name plus a
 * small props bag of counts / flags / enums — NEVER code, prompts, repo names,
 * paths, or file contents.
 *
 * No account token (fresh install pre-bootstrap, or analytics never provisioned)
 * → silent no-op, exactly like the client path. The client opt-out lives in the
 * browser (localStorage) and gates track(); server events are coarse system
 * signals (dispatch / merge / repo-add) with no content, so they ride the same
 * account-token presence check rather than a per-event opt-out.
 */

import { proxyBaseUrl } from '@/lib/cortex/qa/llm/inference-route';
import { readCachedEntitlement } from '@/lib/entitlement/license';

export async function emitProductEvent(event: string, props?: Record<string, unknown>): Promise<void> {
  try {
    const token = readCachedEntitlement()?.licenseKey?.trim();
    if (!token) return;

    const name = event.trim().slice(0, 80);
    if (!name) return;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    try {
      await fetch(`${proxyBaseUrl()}/v1/telemetry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ event: name, ...(props ? { props } : {}) }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // Telemetry must never affect the app.
  }
}
