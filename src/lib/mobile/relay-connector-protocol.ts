import { createHash } from 'node:crypto';

import { resolveFlags } from '@/lib/entitlement/flags';
import type { Plan } from '@/lib/entitlement/types';
import {
  O8_RELAY_FORWARD_HEADER,
  O8_RELAY_FORWARD_MARKER,
  O8_RELAY_SURFACE_HEADER,
  O8_WEB_MACHINE_SURFACE,
} from '@/lib/connect/web-machine-surface';

/**
 * Relay connector — PURE protocol helpers (no server-only, no sqlite, no ws), so
 * they unit-test in isolation (relay-connector.test.ts) and the orchestration
 * class (relay-connector.ts) imports them. Everything here is a total function.
 */

/** Non-loopback socket-truth marker — mirrors the scripts/tauri-export.mjs wrapper
 *  branch (x-o8-relay-forward:1 → this value) so the gate treats a forwarded
 *  request as REMOTE (Bearer required), never loopback-trusted (v1.1 change 1). */
export const RELAY_FORWARD_MARKER = O8_RELAY_FORWARD_MARKER;
export const DEFAULT_RELAY_URL = 'wss://relay.o8.run';
/** ≤256KB post-base64 chunks for large tunnel responses (docs R6). */
export const MAX_HTTP_CHUNK_CHARS = 256 * 1024;
export const DEFAULT_MAX_TUNNEL_BYTES = 32 * 1024 * 1024;

const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/**
 * Base58 (Bitcoin alphabet) — the canonical base-x algorithm, byte-identical to
 * the `bs58` package, so the Mac's routingId matches whatever the mobile client
 * derives. Leading zero bytes → leading '1's; the number itself is base58-encoded
 * into a big-endian digit buffer.
 */
export function base58Encode(source: Uint8Array): string {
  if (source.length === 0) return '';
  let zeros = 0;
  while (zeros < source.length && source[zeros] === 0) zeros++;
  const size = Math.ceil(((source.length - zeros) * 138) / 100) + 1; // log(256)/log(58)
  const b58 = new Uint8Array(size);
  let length = 0;
  for (let i = zeros; i < source.length; i++) {
    let carry = source[i]!;
    let j = 0;
    for (let k = size - 1; (carry !== 0 || j < length) && k >= 0; k--, j++) {
      carry += 256 * b58[k]!;
      b58[k] = carry % 58;
      carry = (carry / 58) | 0;
    }
    length = j;
  }
  let it = size - length;
  while (it < size && b58[it] === 0) it++;
  let str = '1'.repeat(zeros);
  for (; it < size; it++) str += B58_ALPHABET[b58[it]!];
  return str;
}

/** routingId = base58(SHA-256(identity pubkey)[:16]). Derived at connect, never persisted. */
export function deriveRoutingId(identityPublicKeyB64: string): string {
  const pub = Buffer.from(identityPublicKeyB64, 'base64');
  const hash = createHash('sha256').update(pub).digest();
  return base58Encode(hash.subarray(0, 16));
}

/** Off-network relay eligibility: entitled (paid tier) AND the operator setting on. */
export function relayConnectorEligible(plan: Plan, settingEnabled: boolean): boolean {
  return settingEnabled && resolveFlags(plan)['relay.offNetwork'] === true;
}

export interface HttpReqFrame {
  rid?: unknown;
  method?: unknown;
  path?: unknown;
  headers?: unknown;
  bodyB64?: unknown;
  authorization?: unknown;
}

export interface HttpCancelFrame {
  t: 'http-cancel';
  rid: string;
}

export type RelayHttpAbortReason =
  | 'client-cancel'
  | 'stream-teardown'
  | 'connector-stop'
  | 'superseded'
  | 'timeout';

/** Return a request id only for the encrypted HTTP cancellation control frame. */
export function httpCancelRequestId(frame: unknown): string | null {
  if (!frame || typeof frame !== 'object' || Array.isArray(frame)) return null;
  const candidate = frame as { t?: unknown; rid?: unknown };
  return candidate.t === 'http-cancel' && typeof candidate.rid === 'string' && candidate.rid.trim()
    ? candidate.rid
    : null;
}

/**
 * Owns in-flight local HTTP replays by tunnel stream and request id. Removing an
 * entry before aborting makes unknown/late cancels no-ops and prevents a stale
 * request's finally block from deleting a newer request that reused the same id.
 */
export class RelayHttpRequestRegistry {
  private readonly streams = new Map<string, Map<string, AbortController>>();

  begin(sid: string, rid: string): AbortController {
    let requests = this.streams.get(sid);
    if (!requests) {
      requests = new Map();
      this.streams.set(sid, requests);
    }
    const previous = requests.get(rid);
    const controller = new AbortController();
    requests.set(rid, controller);
    previous?.abort('superseded' satisfies RelayHttpAbortReason);
    return controller;
  }

  cancel(sid: string, rid: string): boolean {
    return this.abortCurrent(sid, rid, undefined, 'client-cancel');
  }

  timeout(sid: string, rid: string, controller: AbortController): boolean {
    return this.abortCurrent(sid, rid, controller, 'timeout');
  }

  finish(sid: string, rid: string, controller: AbortController): void {
    const requests = this.streams.get(sid);
    if (requests?.get(rid) !== controller) return;
    requests.delete(rid);
    if (requests.size === 0) this.streams.delete(sid);
  }

  abortStream(sid: string, reason: RelayHttpAbortReason = 'stream-teardown'): number {
    const requests = this.streams.get(sid);
    if (!requests) return 0;
    this.streams.delete(sid);
    for (const controller of requests.values()) controller.abort(reason);
    return requests.size;
  }

  abortAll(reason: RelayHttpAbortReason = 'connector-stop'): number {
    let count = 0;
    for (const sid of [...this.streams.keys()]) count += this.abortStream(sid, reason);
    return count;
  }

  get size(): number {
    let count = 0;
    for (const requests of this.streams.values()) count += requests.size;
    return count;
  }

  private abortCurrent(
    sid: string,
    rid: string,
    expected: AbortController | undefined,
    reason: RelayHttpAbortReason,
  ): boolean {
    const requests = this.streams.get(sid);
    const controller = requests?.get(rid);
    if (!requests || !controller || (expected && controller !== expected)) return false;
    requests.delete(rid);
    if (requests.size === 0) this.streams.delete(sid);
    controller.abort(reason);
    return true;
  }
}

// Only forward a safe subset of client headers; the marker + Bearer are set below.
const FORWARDABLE_HEADERS = new Set([
  'content-type',
  'accept',
  'accept-language',
  'if-none-match',
  'if-modified-since',
  'if-range',
  'range',
  'x-o8-mobile-surface',
]);

export type ReplayPlan =
  | { ok: true; url: string; method: string; headers: Record<string, string>; body?: Buffer }
  | { ok: false; status: number; error: string };

/**
 * Build the local replay for an `http-req` frame. SSRF-safe (local absolute path
 * only), stamps the NON-loopback marker + the prod-wrapper trigger + the phone's
 * Bearer so src/middleware.ts gates it exactly like a LAN phone (v1.1 change 1).
 */
export function buildHttpReplay(
  req: HttpReqFrame,
  apiBase: string,
  options: { relaySurface?: typeof O8_WEB_MACHINE_SURFACE } = {},
): ReplayPlan {
  const path = typeof req.path === 'string' ? req.path : '';
  // Local absolute path only — never a full URL, protocol-relative, or traversal.
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\') || path.includes('..')) {
    return { ok: false, status: 400, error: 'bad_path' };
  }
  const method = (typeof req.method === 'string' ? req.method : 'GET').toUpperCase();
  const headers: Record<string, string> = {};
  if (req.headers && typeof req.headers === 'object') {
    for (const [k, v] of Object.entries(req.headers as Record<string, unknown>)) {
      const lk = k.toLowerCase();
      if (FORWARDABLE_HEADERS.has(lk) && typeof v === 'string') headers[lk] = v;
    }
  }
  const auth = pickAuthorization(req);
  if (auth) headers['authorization'] = auth;
  // v1.1 change 1: socket-truth marker (dev) + wrapper trigger (prod). Both make
  // the gate treat this as REMOTE — a loopback-trusted tunnel is forbidden.
  headers['x-o8-client-addr'] = RELAY_FORWARD_MARKER;
  headers[O8_RELAY_FORWARD_HEADER] = '1';
  if (options.relaySurface === O8_WEB_MACHINE_SURFACE) {
    headers[O8_RELAY_SURFACE_HEADER] = O8_WEB_MACHINE_SURFACE;
  }
  const body =
    typeof req.bodyB64 === 'string' && req.bodyB64 && method !== 'GET' && method !== 'HEAD'
      ? Buffer.from(req.bodyB64, 'base64')
      : undefined;
  return { ok: true, url: `${apiBase}${path}`, method, headers, body };
}

function pickAuthorization(req: HttpReqFrame): string | null {
  if (typeof req.authorization === 'string' && req.authorization) return req.authorization;
  if (req.headers && typeof req.headers === 'object') {
    const h = req.headers as Record<string, unknown>;
    const a = h.authorization ?? h.Authorization;
    if (typeof a === 'string' && a) return a;
  }
  return null;
}

/** Split a base64 body into ≤256KB chunks (first rides http-res, rest http-res-part). */
export function chunkBase64(base64: string, maxChars = MAX_HTTP_CHUNK_CHARS): string[] {
  if (base64.length <= maxChars) return [base64];
  const out: string[] = [];
  for (let i = 0; i < base64.length; i += maxChars) out.push(base64.slice(i, i + maxChars));
  return out;
}

/** Mac-origin close codes pass through the relay unchanged; relay-origin do not. */
export function passthroughCloseCode(code: number): number | null {
  return code === 4401 || code === 4403 ? code : null;
}
