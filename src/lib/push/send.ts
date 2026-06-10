/**
 * Web Push send — performs the HTTPS request to the browser-supplied push
 * service (Apple, Google, Mozilla) with a VAPID JWT and an aes128gcm body.
 *
 * Issue: https://github.com/hurttlocker/o8/issues/639
 */

import 'server-only';
import {
  recordDeliveryFailure,
  recordDeliverySuccess,
  type StoredPushSubscription,
} from './store';
import { encryptPayload } from './encrypt';
import { buildVapidJwt, getVapidKeys } from './vapid';

export interface PushPayload {
  /** Notification title (short) */
  title: string;
  /** Notification body (longer description) */
  body: string;
  /** Tag used by the browser to collapse repeated notifications */
  tag?: string;
  /** Deep-link URL opened on tap (relative or absolute) */
  url?: string;
  /** Optional opaque metadata stored on the notification's data field */
  data?: Record<string, unknown>;
}

export interface SendResult {
  endpoint: string;
  ok: boolean;
  status: number;
  reason?: string;
}

/** Default TTL — push services hold the message this many seconds when the device is offline. */
const DEFAULT_TTL_SECONDS = 60 * 60; // 1 hour

/** Per-request timeout for the HTTP push call. */
const PUSH_REQUEST_TIMEOUT_MS = 10_000;

function audienceFromEndpoint(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    return `${url.protocol}//${url.host}`;
  } catch {
    return endpoint;
  }
}

export async function sendPushToSubscription(
  sub: StoredPushSubscription,
  payload: PushPayload,
  options: { ttlSeconds?: number } = {},
): Promise<SendResult> {
  // Webhook fallback — bypass Web Push entirely.
  if (sub.webhookUrl) {
    return sendWebhook(sub, payload);
  }

  let body: Buffer;
  let jwt: string;
  let publicKey: string;
  try {
    const json = JSON.stringify({
      title: payload.title,
      body: payload.body,
      tag: payload.tag,
      url: payload.url,
      data: payload.data,
    });
    body = encryptPayload(Buffer.from(json, 'utf-8'), {
      p256dh: sub.p256dh,
      auth: sub.auth,
    });
    const aud = audienceFromEndpoint(sub.endpoint);
    jwt = buildVapidJwt(aud);
    publicKey = getVapidKeys().publicKeyBase64Url;
  } catch (error) {
    console.error('[push-send] failed to build push request', error);
    return {
      endpoint: sub.endpoint,
      ok: false,
      status: 0,
      reason: error instanceof Error ? error.message : 'encryption failed',
    };
  }

  const ttl = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), PUSH_REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(sub.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Encoding': 'aes128gcm',
        'TTL': String(ttl),
        'Authorization': `vapid t=${jwt}, k=${publicKey}`,
      },
      body,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (res.status === 201 || res.status === 200 || res.status === 202) {
      recordDeliverySuccess(sub.endpoint);
      return { endpoint: sub.endpoint, ok: true, status: res.status };
    }

    if (res.status === 404 || res.status === 410) {
      // Subscription is permanently gone — drop it.
      recordDeliveryFailure(sub.endpoint, { permanent: true });
      return { endpoint: sub.endpoint, ok: false, status: res.status, reason: 'subscription expired' };
    }

    recordDeliveryFailure(sub.endpoint);
    return { endpoint: sub.endpoint, ok: false, status: res.status, reason: `HTTP ${res.status}` };
  } catch (error) {
    clearTimeout(timeoutId);
    recordDeliveryFailure(sub.endpoint);
    return {
      endpoint: sub.endpoint,
      ok: false,
      status: 0,
      reason: error instanceof Error ? error.message : 'fetch failed',
    };
  }
}

async function sendWebhook(
  sub: StoredPushSubscription,
  payload: PushPayload,
): Promise<SendResult> {
  if (!sub.webhookUrl) {
    return { endpoint: sub.endpoint, ok: false, status: 0, reason: 'no webhook configured' };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), PUSH_REQUEST_TIMEOUT_MS);

  try {
    // ntfy.sh / Pushover-compatible payload — keep it boring.
    const res = await fetch(sub.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: payload.title,
        message: payload.body,
        tag: payload.tag,
        url: payload.url,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (res.ok) {
      recordDeliverySuccess(sub.endpoint);
      return { endpoint: sub.endpoint, ok: true, status: res.status };
    }
    recordDeliveryFailure(sub.endpoint);
    return { endpoint: sub.endpoint, ok: false, status: res.status, reason: `webhook HTTP ${res.status}` };
  } catch (error) {
    clearTimeout(timeoutId);
    recordDeliveryFailure(sub.endpoint);
    return {
      endpoint: sub.endpoint,
      ok: false,
      status: 0,
      reason: error instanceof Error ? error.message : 'webhook fetch failed',
    };
  }
}
