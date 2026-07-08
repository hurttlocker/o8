/**
 * o8 relay wire protocol — v1.1 (docs/relay-v1-design.md §"Wire contract").
 *
 * FROZEN. The mobile client leg + the desktop connector are built against this
 * verbatim. Two legs, one codec:
 *
 *   phone ──wss /device/{routingId}── relay ──wss /mac── Mac connector
 *
 * Everything is JSON text with a `t` discriminator. The relay NEVER inspects a
 * `payload` — it forwards the opaque base64 bytes untouched (that is the whole
 * zero-knowledge guarantee: the relay learns routing ids, presence, entitlement,
 * and frame sizes — nothing else).
 *
 *  - Data frame `mux`: `{t:'mux', sid?, seq, payload}` — payload = base64(raw bytes,
 *    incl. the untouched {e2ee:1,n,c} envelope + the in-tunnel auth/http frames).
 *    `sid` is present Mac-side (demux which phone) and absent phone-side (one stream).
 *  - Control (relay→phone): `presence {mac}`.
 *  - Control (relay→Mac):   `devices {count}`, `mux-open {sid}`, `mux-close {sid}`.
 *  - Control (Mac→relay):   `push-req {apnsAlertToken, environment, kind}`,
 *                           `mux-close {sid, code?, reason?}` (close a phone).
 */

// ── Close codes ──────────────────────────────────────────────────────────────
export const CLOSE = {
  /** Mac-origin, passthrough: per-device token revoked → client re-pairs. */
  TOKEN_REVOKED: 4401,
  /** Mac-origin, passthrough: E2EE handshake / first-frame auth rejected → re-pair. */
  HANDSHAKE_REJECTED: 4403,
  /** Relay-origin: no Mac socket for this routingId within the hold window → backoff. */
  MAC_OFFLINE: 4408,
  /** Relay-origin: plan-JWT expired / relay.offNetwork false at connect → stop until refresh. */
  ENTITLEMENT_LAPSED: 4409,
} as const;

export type MacOriginCloseCode = typeof CLOSE.TOKEN_REVOKED | typeof CLOSE.HANDSHAKE_REJECTED;
/** Close codes the Mac may ask the relay to pass through to a phone, unchanged. */
export function isMacOriginCloseCode(code: unknown): code is MacOriginCloseCode {
  return code === CLOSE.TOKEN_REVOKED || code === CLOSE.HANDSHAKE_REJECTED;
}

// ── Frame shapes ─────────────────────────────────────────────────────────────
export interface MuxFrame {
  t: 'mux';
  /** Present Mac-side only (identifies the phone stream). Absent phone-side. */
  sid?: string;
  seq: number;
  /** base64 of the opaque raw bytes. Relay forwards this untouched. */
  payload: string;
}
export interface PresenceFrame {
  t: 'presence';
  mac: 'up' | 'down';
}
export interface DevicesFrame {
  t: 'devices';
  count: number;
}
export interface MuxOpenFrame {
  t: 'mux-open';
  sid: string;
}
export interface MuxCloseFrame {
  t: 'mux-close';
  sid: string;
  /** Only set when the Mac initiates the close (4401/4403 passthrough). */
  code?: number;
  reason?: string;
}
export interface PushReqFrame {
  t: 'push-req';
  /** A REAL remote-notification device token (NOT the ActivityKit token). */
  apnsAlertToken: string;
  environment: 'sandbox' | 'production';
  kind: string;
}
/**
 * Mac→relay ONLY. The connector emits this once a bridged phone stream passes
 * first-frame `auth` + the mandatory E2EE handshake, so the relay can clear the
 * socket's "pending-unauth" flag + 10s handshake deadline. Invisible to the phone
 * (Mac↔relay internal), so it does NOT alter the frozen mobile-facing contract.
 */
export interface MuxReadyFrame {
  t: 'mux-ready';
  sid: string;
}

export type PhoneInboundFrame = MuxFrame; // relay ← phone
export type PhoneOutboundFrame = MuxFrame | PresenceFrame; // relay → phone
export type MacInboundFrame = MuxFrame | MuxCloseFrame | MuxReadyFrame | PushReqFrame; // relay ← Mac
export type MacOutboundFrame = MuxFrame | DevicesFrame | MuxOpenFrame | MuxCloseFrame; // relay → Mac

// ── Codec ────────────────────────────────────────────────────────────────────
export function encode(frame: object): string {
  return JSON.stringify(frame);
}

/** Parse a ws text/binary message into a frame object, or null if it's not JSON. */
export function decode(raw: string | Buffer): Record<string, unknown> | null {
  try {
    const text = typeof raw === 'string' ? raw : raw.toString('utf8');
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Encode raw bytes as an opaque payload string. */
export function toPayload(bytes: Uint8Array | Buffer | string): string {
  if (typeof bytes === 'string') return Buffer.from(bytes, 'utf8').toString('base64');
  return Buffer.from(bytes).toString('base64');
}

/** Decode an opaque payload string back to raw bytes. */
export function fromPayload(payload: string): Buffer {
  return Buffer.from(payload, 'base64');
}

export function isMuxFrame(f: Record<string, unknown> | null): f is MuxFrame & Record<string, unknown> {
  return !!f && f.t === 'mux' && typeof f.payload === 'string' && typeof f.seq === 'number';
}
