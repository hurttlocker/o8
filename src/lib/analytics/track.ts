'use client';

/**
 * Browser product telemetry. Consent is read from the server-owned operator
 * defaults before every event, and the POST is gated again on the server.
 * The legacy localStorage opt-out key is intentionally ignored: neither its
 * absence nor any other browser-only state can create consent.
 */

import {
  sanitizeProductEvent,
  type ProductEventName,
  type ProductEventProps,
  type ProductEventPayload,
} from './events';

async function sendIfOptedIn(payload: ProductEventPayload): Promise<void> {
  const consentResponse = await fetch('/api/panel/telemetry', {
    method: 'GET',
    cache: 'no-store',
  });
  if (!consentResponse.ok) return;

  const consent = (await consentResponse.json().catch(() => null)) as { enabled?: unknown } | null;
  if (consent?.enabled !== true) return;

  await fetch('/api/panel/telemetry', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    keepalive: true,
  });
}

export function track(event: ProductEventName, props?: ProductEventProps): void {
  try {
    if (typeof window === 'undefined') return;
    const payload = sanitizeProductEvent(event, props);
    if (!payload) return;
    void sendIfOptedIn(payload).catch(() => {});
  } catch {
    // Telemetry must never affect the app.
  }
}
