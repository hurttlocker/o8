import { connect, constants as http2Constants } from 'node:http2';
import type { ClientHttp2Stream } from 'node:http2';

import { importPKCS8, SignJWT } from 'jose';

import { env } from './env.js';

/**
 * APNs sender — the notify half of queue-and-notify (docs §D4).
 *
 * Sends a GENERIC ALERT push ("o8 needs you — approval waiting", no content) to a
 * REAL remote-notification device token (apns-push-type: alert). This is NOT the
 * ActivityKit token — Apple rejects generic alerts against Live-Activity update
 * tokens (mobile redline R3). The token arrives in a `push-req` control frame and
 * is used TRANSIENTLY per request — never stored (the relay has no database).
 *
 * Mirrors the desktop HTTP/2 pattern in src/lib/mobile/live-activity-push.ts:
 * ES256 provider JWT from the .p8, cached ~20min. Never throws — returns a
 * structured result the caller logs.
 */

const APNS_JWT_TTL_SECONDS = 20 * 60;
const APNS_REQUEST_TIMEOUT_MS = 10_000;

let jwtCache: { token: string; expiresAt: number } | null = null;

async function providerJwt(): Promise<string> {
  const apns = env.APNS;
  if (!apns) throw new Error('apns_not_configured');
  if (jwtCache && jwtCache.expiresAt > Date.now() + 60_000) return jwtCache.token;

  const key = await importPKCS8(apns.keyP8, 'ES256');
  const nowSeconds = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: apns.keyId })
    .setIssuer(apns.teamId)
    .setIssuedAt(nowSeconds)
    .setExpirationTime(nowSeconds + APNS_JWT_TTL_SECONDS)
    .sign(key);
  jwtCache = { token, expiresAt: Date.now() + APNS_JWT_TTL_SECONDS * 1000 };
  return token;
}

interface Http2Response {
  status: number;
  reason: string | null;
}

function sendHttp2({
  host,
  deviceToken,
  authorization,
  topic,
  payload,
}: {
  host: string;
  deviceToken: string;
  authorization: string;
  topic: string;
  payload: unknown;
}): Promise<Http2Response> {
  return new Promise((resolve, reject) => {
    const session = connect(`https://${host}`);
    let request: ClientHttp2Stream | null = null;
    let settled = false;
    let status = 0;
    let body = '';

    const timeout = setTimeout(() => {
      finish(() => reject(new Error('APNs request timed out')));
    }, APNS_REQUEST_TIMEOUT_MS);

    const finish = (complete: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      request?.close();
      session.close();
      complete();
    };

    session.on('error', (error) => finish(() => reject(error)));

    request = session.request({
      [http2Constants.HTTP2_HEADER_METHOD]: 'POST',
      [http2Constants.HTTP2_HEADER_PATH]: `/3/device/${deviceToken}`,
      authorization,
      'apns-topic': topic,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'content-type': 'application/json',
    });
    request.setEncoding('utf8');
    request.on('response', (headers) => {
      const s = headers[http2Constants.HTTP2_HEADER_STATUS];
      status = typeof s === 'number' ? s : Number(Array.isArray(s) ? s[0] : s ?? 0);
    });
    request.on('data', (chunk) => {
      body += String(chunk);
    });
    request.on('end', () => {
      finish(() => {
        let reason: string | null = null;
        if (body.trim().length > 0) {
          try {
            reason = (JSON.parse(body) as { reason?: string }).reason ?? null;
          } catch {
            reason = body.trim();
          }
        }
        resolve({ status, reason });
      });
    });
    request.on('error', (error) => finish(() => reject(error)));
    request.end(JSON.stringify(payload));
  });
}

export interface PushResult {
  ok: boolean;
  status?: number;
  reason?: string;
}

/** True when the .p8 + key id + team id are configured (else push is a no-op). */
export function apnsConfigured(): boolean {
  return env.APNS !== null;
}

/**
 * Send the generic "approval waiting" alert. `environment` selects the APNs host;
 * `apnsAlertToken` is the phone's remote-notification device token (transient).
 */
export async function sendApprovalAlert(input: {
  apnsAlertToken: string;
  environment: 'sandbox' | 'production';
  kind: string;
}): Promise<PushResult> {
  const apns = env.APNS;
  if (!apns) return { ok: false, reason: 'apns_not_configured' };

  const token = input.apnsAlertToken.trim();
  if (!/^[a-fA-F0-9]{32,}$/.test(token)) return { ok: false, reason: 'invalid_token' };

  const host = input.environment === 'production' ? 'api.push.apple.com' : 'api.sandbox.push.apple.com';
  const payload = {
    aps: {
      alert: { title: 'o8 needs you', body: 'An approval is waiting.' },
      sound: 'default',
      'interruption-level': 'time-sensitive',
    },
    kind: input.kind,
  };

  try {
    const jwt = await providerJwt();
    const res = await sendHttp2({
      host,
      deviceToken: token,
      authorization: `bearer ${jwt}`,
      topic: apns.bundleId,
      payload,
    });
    return { ok: res.status === 200, status: res.status, reason: res.reason ?? undefined };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
