import 'server-only';

import { createHash } from 'node:crypto';

import { WebSocket } from 'ws';

import { resolveFlags } from '@/lib/entitlement/flags';
import type { Plan } from '@/lib/entitlement/types';
import { resolvePortInfo } from '@/lib/panel/api-port';

import { startServerHandshake, completeServerHandshake, type ServerHandshake } from './e2ee-channel';
import { encryptFrame, decryptFrame, isEncryptedFrame, type EncryptedFrame } from './e2ee-crypto';
import { getServerIdentity } from './e2ee-identity';
import { resolveDeviceByToken, type MobileDevice } from './device-registry';
import { listRemoteNotificationTokens } from './live-activity-push';

/**
 * o8 Relay connector — the Mac-side outbound leg (docs/relay-v1-design.md §D8.2).
 *
 * The Mac dials OUT to the relay (no inbound ports). For each relayed phone the
 * connector TERMINATES the Mac-side tunnel — it must, because v1.1 requires it to
 * read the in-tunnel `auth {token}` (first-frame gate) and `http-req` (replayed to
 * local Next), both of which live inside the E2EE channel, so the connector holds
 * the session key (it is Mac-side + fully trusted; the ZERO-KNOWLEDGE constraint
 * binds the RELAY, not this). Per bridged stream:
 *
 *   await-auth → first frame MUST be `auth {token}`, validated against the device
 *                registry; invalid → close 4403 (held unauthenticated until then)
 *   handshaking → mandatory server-initiated E2EE (same identity key as ws-server,
 *                 so the phone's pinned key matches); failure → 4403, NO raw fallback
 *   ready       → decrypt each frame: `http-req` → replay to 127.0.0.1:{apiPort}
 *                 stamping a NON-loopback x-o8-client-addr marker + the phone's
 *                 Bearer (middleware gates per-route, never loopback-trusted); every
 *                 other frame → bridged to a local ws-server connection (the realtime
 *                 channels). Mac-origin 4401/4403 closes pass back through the relay.
 *
 * HARD ISOLATION: the whole connector is gated behind entitlement + an operator
 * setting + O8_RELAY_URL, wrapped so a failure NEVER touches the LAN path. When the
 * relay is down the Mac simply isn't reachable off-network; LAN is unaffected.
 *
 * NOTE: the live E2EE-channel bridge + real-phone interop is validated by the
 * Q-gated cross-network e2e (docs §D8.5) with the real mobile client — it cannot
 * be exercised in-repo. The contract-critical PURE logic below is unit-tested
 * (relay-connector.test.ts); the relay half is proven by services/relay e2e.
 */

const P = '[relay]';

/** Non-loopback socket-truth marker (mirrors scripts/tauri-export.mjs wrapper). */
export const RELAY_FORWARD_MARKER = 'o8-relay-forward';
export const DEFAULT_RELAY_URL = 'wss://relay.o8.run';
/** ≤256KB post-base64 chunks for large tunnel responses (docs R6). */
const MAX_HTTP_CHUNK_CHARS = 256 * 1024;
const DEFAULT_MAX_TUNNEL_BYTES = 32 * 1024 * 1024;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_CAP_MS = 30_000;
const STREAM_HANDSHAKE_DEADLINE_MS = 8_000; // must beat the relay's 10s

// ── Pure helpers (exported for unit tests) ────────────────────────────────────

const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Base58 (Bitcoin alphabet) — matches the mobile client's routingId derivation. */
export function base58Encode(bytes: Uint8Array): string {
  if (bytes.length === 0) return '';
  const digits: number[] = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j]! << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = '';
  for (let k = 0; k < bytes.length && bytes[k] === 0; k++) out += '1';
  for (let q = digits.length - 1; q >= 0; q--) out += B58_ALPHABET[digits[q]!];
  return out;
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

// Only forward a safe subset of client headers; the marker + Bearer are set below.
const FORWARDABLE_HEADERS = new Set([
  'content-type',
  'accept',
  'accept-language',
  'if-none-match',
  'if-modified-since',
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
export function buildHttpReplay(req: HttpReqFrame, apiBase: string): ReplayPlan {
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
  headers['x-o8-relay-forward'] = '1';
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

// ── Connector orchestration ───────────────────────────────────────────────────

type StreamPhase = 'await-auth' | 'handshaking' | 'ready';

interface StreamState {
  sid: string;
  phase: StreamPhase;
  device?: MobileDevice;
  deviceToken?: string;
  handshake?: ServerHandshake;
  sessionKey?: Uint8Array;
  bridge?: WebSocket;
  deadline?: ReturnType<typeof setTimeout>;
}

export interface RelayConnectorConfig {
  plan: Plan;
  settingEnabled: boolean;
  relayUrl?: string;
  licenseToken: string | null;
  /** Non-empty only when a blocked approval is waiting (drives push-req). */
  blockedApprovalCount: () => number;
  maxTunnelBytes?: number;
}

export class RelayConnector {
  private ws: WebSocket | null = null;
  private readonly streams = new Map<string, StreamState>();
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private liveDeviceCount = 0;
  private readonly routingId: string;
  private readonly relayUrl: string;
  private readonly maxTunnelBytes: number;

  constructor(private readonly config: RelayConnectorConfig) {
    this.routingId = deriveRoutingId(getServerIdentity().publicKeyB64);
    this.relayUrl = (config.relayUrl || process.env.O8_RELAY_URL || DEFAULT_RELAY_URL).replace(/\/+$/, '');
    this.maxTunnelBytes = config.maxTunnelBytes ?? DEFAULT_MAX_TUNNEL_BYTES;
  }

  get id(): string {
    return this.routingId;
  }

  start(): void {
    if (!this.config.licenseToken) {
      console.warn(`${P} connector not started — no license token available`);
      return;
    }
    this.stopped = false;
    this.dial();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    for (const sid of [...this.streams.keys()]) this.teardownStream(sid);
    try {
      this.ws?.close(1000, 'connector stop');
    } catch {
      /* already gone */
    }
    this.ws = null;
  }

  private dial(): void {
    if (this.stopped) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(`${this.relayUrl}/mac`, {
        headers: {
          authorization: `Bearer ${this.config.licenseToken}`,
          'x-o8-routing-id': this.routingId,
        },
      });
    } catch (err) {
      console.warn(`${P} dial failed: ${errMsg(err)}`);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.on('open', () => {
      this.reconnectAttempts = 0;
      console.log(`${P} connector up → ${this.relayUrl} (routingId=${this.routingId.slice(0, 8)}…)`);
    });
    ws.on('message', (raw) => this.onRelayMessage(raw));
    ws.on('close', (code) => {
      // 4409 = entitlement lapsed at the relay; stop retrying until re-evaluated.
      if (code === 4409) {
        console.warn(`${P} connector closed 4409 entitlement_lapsed — standing down`);
        this.stopped = true;
        return;
      }
      this.scheduleReconnect();
    });
    ws.on('error', (err) => {
      console.warn(`${P} connector socket error: ${errMsg(err)}`);
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    for (const sid of [...this.streams.keys()]) this.teardownStream(sid);
    const delay = Math.min(RECONNECT_CAP_MS, RECONNECT_BASE_MS * 2 ** this.reconnectAttempts);
    this.reconnectAttempts = Math.min(this.reconnectAttempts + 1, 8);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.dial(), delay);
    this.reconnectTimer.unref?.();
  }

  // ── relay → connector ──
  private onRelayMessage(raw: unknown): void {
    let frame: Record<string, unknown> | null = null;
    try {
      frame = JSON.parse(typeof raw === 'string' ? raw : (raw as Buffer).toString('utf8')) as Record<string, unknown>;
    } catch {
      return;
    }
    if (!frame) return;
    switch (frame.t) {
      case 'mux-open':
        this.openStream(String(frame.sid));
        return;
      case 'mux-close':
        this.teardownStream(String(frame.sid));
        return;
      case 'devices':
        this.liveDeviceCount = typeof frame.count === 'number' ? frame.count : 0;
        this.maybePushOnDevices();
        return;
      case 'mux':
        if (typeof frame.sid === 'string' && typeof frame.payload === 'string') {
          this.onStreamPayload(frame.sid, frame.payload);
        }
        return;
      default:
        return;
    }
  }

  private openStream(sid: string): void {
    if (this.streams.has(sid)) return;
    const state: StreamState = { sid, phase: 'await-auth' };
    state.deadline = setTimeout(() => this.closeStream(sid, 4403, 'handshake_deadline'), STREAM_HANDSHAKE_DEADLINE_MS);
    state.deadline.unref?.();
    this.streams.set(sid, state);
  }

  private onStreamPayload(sid: string, payloadB64: string): void {
    const state = this.streams.get(sid);
    if (!state) return;
    const bytes = Buffer.from(payloadB64, 'base64');

    if (state.phase === 'await-auth') {
      const inner = parseJson(bytes);
      if (!inner || inner.t !== 'auth') return; // held unauthenticated — drop
      const token = typeof inner.token === 'string' ? inner.token : '';
      const device = token ? safe(() => resolveDeviceByToken(token)) : null;
      if (!device) {
        this.closeStream(sid, 4403, 'auth_rejected');
        return;
      }
      state.device = device;
      state.deviceToken = token;
      this.startStreamHandshake(state);
      return;
    }

    if (state.phase === 'handshaking') {
      const inner = parseJson(bytes);
      if (!inner || inner.type !== 'e2ee-init' || !state.handshake) return;
      const result = completeServerHandshake(state.handshake, {
        clientEphPub: inner.clientEphPub,
        clientNonce: inner.clientNonce,
        clientSig: inner.clientSig,
      });
      if ('error' in result) {
        this.closeStream(sid, 4403, `e2ee: ${result.error}`);
        return;
      }
      state.sessionKey = result.sessionKey;
      state.handshake = undefined;
      state.phase = 'ready';
      if (state.deadline) clearTimeout(state.deadline);
      this.sendEncrypted(state, { channel: 'system', event: 'e2ee-ready' });
      this.sendControl({ t: 'mux-ready', sid }); // relay clears pending + deadline
      this.openBridge(state);
      return;
    }

    // ready — decrypt the {e2ee,n,c} envelope and route the plaintext.
    if (!state.sessionKey) return;
    const parsed = parseJson(bytes);
    if (!isEncryptedFrame(parsed)) return;
    const plaintext = decryptFrame(parsed as EncryptedFrame, state.sessionKey);
    if (plaintext === null) return; // couldn't decrypt — drop
    const msg = safeParse(plaintext);
    if (!msg) return;
    if (msg.t === 'http-req') {
      void this.replayHttp(state, msg as HttpReqFrame);
      return;
    }
    // Everything else is a realtime ws channel frame → bridge to the local ws-server.
    if (state.bridge && state.bridge.readyState === WebSocket.OPEN) {
      try {
        state.bridge.send(plaintext);
      } catch {
        /* bridge gone */
      }
    }
  }

  private startStreamHandshake(state: StreamState): void {
    if (!state.device) return;
    try {
      const { handshake, hello } = startServerHandshake(getServerIdentity(), state.device.identityPublicKey);
      state.handshake = handshake;
      state.phase = 'handshaking';
      // hello is PLAINTEXT (it establishes the key) but signed by the server identity.
      this.sendPlain(state, { channel: 'system', event: 'e2ee-hello', data: hello });
    } catch (err) {
      this.closeStream(state.sid, 4403, `handshake_init: ${errMsg(err)}`);
    }
  }

  private openBridge(state: StreamState): void {
    if (!state.deviceToken) return;
    const { wsPort } = resolvePortInfo();
    let bridge: WebSocket;
    try {
      // Loopback to our own ws-server. The connector already did device-auth +
      // E2EE, so this hop is a trusted plaintext loopback channel.
      bridge = new WebSocket(`ws://127.0.0.1:${wsPort}/ws?token=${encodeURIComponent(state.deviceToken)}`);
    } catch (err) {
      console.warn(`${P} bridge dial failed sid=${state.sid}: ${errMsg(err)}`);
      return;
    }
    state.bridge = bridge;
    bridge.on('message', (raw) => {
      // ws-server → phone: encrypt the plaintext channel frame and tunnel it back.
      const text = typeof raw === 'string' ? raw : (raw as Buffer).toString('utf8');
      const obj = safeParse(text);
      if (obj) this.sendEncrypted(state, obj);
    });
    bridge.on('close', (code) => {
      // A Mac-origin revoke/reject (4401/4403) rides back to the phone unchanged.
      const passthrough = passthroughCloseCode(code);
      this.closeStream(state.sid, passthrough ?? undefined, 'bridge_closed');
    });
    bridge.on('error', () => {/* close handler tears down */});
  }

  private async replayHttp(state: StreamState, req: HttpReqFrame): Promise<void> {
    const rid = req.rid;
    const { apiPort } = resolvePortInfo();
    const plan = buildHttpReplay(req, `http://127.0.0.1:${apiPort}`);
    if (!plan.ok) {
      this.sendEncrypted(state, { t: 'http-res', rid, status: plan.status, error: plan.error, bodyB64: '' });
      return;
    }
    try {
      const resp = await fetch(plan.url, { method: plan.method, headers: plan.headers, body: plan.body });
      const buf = Buffer.from(await resp.arrayBuffer());
      if (buf.length > this.maxTunnelBytes) {
        this.sendEncrypted(state, { t: 'http-res', rid, status: 413, error: 'tunnel_response_too_large', bodyB64: '' });
        return;
      }
      const chunks = chunkBase64(buf.toString('base64'));
      const headers = subsetResponseHeaders(resp.headers);
      this.sendEncrypted(state, {
        t: 'http-res',
        rid,
        status: resp.status,
        headers,
        bodyB64: chunks[0] ?? '',
        last: chunks.length <= 1,
      });
      for (let i = 1; i < chunks.length; i++) {
        this.sendEncrypted(state, { t: 'http-res-part', rid, i, last: i === chunks.length - 1, bodyB64: chunks[i] });
      }
    } catch (err) {
      this.sendEncrypted(state, { t: 'http-res', rid, status: 502, error: errMsg(err), bodyB64: '' });
    }
  }

  // ── push-req (queue-and-notify) ──
  private maybePushOnDevices(): void {
    if (this.liveDeviceCount > 0) return;
    if (safe(() => this.config.blockedApprovalCount()) ?? 0 <= 0) return;
    const tokens = safe(() => listRemoteNotificationTokens()) ?? [];
    const target = tokens[0];
    if (!target) return; // no alert-capable token registered yet (mobile must add it)
    this.sendControl({ t: 'push-req', apnsAlertToken: target.token, environment: target.environment, kind: 'approval' });
  }

  // ── send helpers ──
  private sendControl(frame: object): void {
    try {
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(frame));
    } catch {
      /* relay gone */
    }
  }

  private sendPlain(state: StreamState, obj: object): void {
    this.sendControl({ t: 'mux', sid: state.sid, seq: 0, payload: Buffer.from(JSON.stringify(obj), 'utf8').toString('base64') });
  }

  private sendEncrypted(state: StreamState, obj: object): void {
    if (!state.sessionKey) return;
    const frame = encryptFrame(JSON.stringify(obj), state.sessionKey);
    this.sendControl({ t: 'mux', sid: state.sid, seq: 0, payload: Buffer.from(JSON.stringify(frame), 'utf8').toString('base64') });
  }

  private closeStream(sid: string, code?: number, reason?: string): void {
    if (!this.streams.has(sid)) return;
    this.sendControl({ t: 'mux-close', sid, ...(code ? { code, reason } : {}) });
    this.teardownStream(sid);
  }

  private teardownStream(sid: string): void {
    const state = this.streams.get(sid);
    if (!state) return;
    if (state.deadline) clearTimeout(state.deadline);
    try {
      state.bridge?.close();
    } catch {
      /* already gone */
    }
    this.streams.delete(sid);
  }
}

// ── module-level helpers ──
function parseJson(bytes: Buffer): Record<string, unknown> | null {
  return safeParse(bytes.toString('utf8'));
}
function safeParse(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
function subsetResponseHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ['content-type', 'etag', 'cache-control', 'content-language']) {
    const v = headers.get(key);
    if (v) out[key] = v;
  }
  return out;
}
function safe<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}
function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
