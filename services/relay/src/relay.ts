import type { IncomingMessage } from 'node:http';

import type { WebSocket } from 'ws';

import { relayOffNetwork, type Plan } from './entitlement.js';
// type-only imports: keep relay.ts env-free so RelayServer constructs with fakes
// in tests. index.ts injects the real env-backed verify/APNs deps.
import type { PlanTokenResult } from './plan-jwt.js';
import type { PushResult } from './apns.js';
import {
  CLOSE,
  decode,
  encode,
  isMacOriginCloseCode,
  isMuxFrame,
} from './protocol.js';
import {
  DEFAULT_RATE_LIMITS,
  RateLimiter,
  RoutingTable,
  type DeviceEntry,
  type RateLimiterOpts,
} from './routing.js';

/**
 * The zero-knowledge relay concentrator (docs/relay-v1-design.md §D2–D5).
 *
 * Two socket kinds, forwarded opaquely:
 *   Mac connector ──/mac──► relay ◄──/device/{routingId}── phone
 *
 * The relay verifies the Mac's plan-JWT + relay.offNetwork entitlement, tracks
 * presence, enforces rate limits, and passes 4401/4403 closes through from the
 * Mac unchanged (relay-origin closes are 4408/4409). It NEVER reads a `payload`.
 *
 * All durations + the JWT/entitlement/APNs deps are injectable so the contract
 * test + e2e can drive it with short timers and fakes.
 */

export interface RelayDeps {
  verifyPlanToken: (token: string | null | undefined) => Promise<PlanTokenResult>;
  relayOffNetwork: (plan: Plan) => boolean;
  sendApprovalAlert: (input: {
    apnsAlertToken: string;
    environment: 'sandbox' | 'production';
    kind: string;
  }) => Promise<PushResult>;
  apnsConfigured: () => boolean;
  now: () => number;
  rateLimits: RateLimiterOpts;
  macOfflineHoldMs: number;
  handshakeDeadlineMs: number;
  idleSweepMs: number;
  idleMaxMs: number;
}

const DEFAULT_DEPS: RelayDeps = {
  // Env-backed deps default to fail-closed stubs (no env import here); index.ts
  // injects the real ones. A relay with the default verifier rejects every Mac.
  verifyPlanToken: async () => ({ ok: false, reason: 'no verifier configured' }),
  relayOffNetwork,
  sendApprovalAlert: async () => ({ ok: false, reason: 'apns_not_configured' }),
  apnsConfigured: () => false,
  now: Date.now,
  rateLimits: DEFAULT_RATE_LIMITS,
  macOfflineHoldMs: 60_000,
  handshakeDeadlineMs: 10_000,
  idleSweepMs: 60_000,
  idleMaxMs: 10 * 60_000,
};

interface DeviceMeta {
  routingId: string;
  sid: string;
  holdTimer?: ReturnType<typeof setTimeout>;
  handshakeTimer?: ReturnType<typeof setTimeout>;
}

const P = '[relay]';

export class RelayServer {
  private readonly deps: RelayDeps;
  private readonly routing = new RoutingTable<WebSocket>();
  private readonly limiter: RateLimiter;
  private readonly deviceMeta = new Map<WebSocket, DeviceMeta>();
  private readonly macRouting = new Map<WebSocket, string>();
  private sidCounter = 0;
  private idleSweepTimer?: ReturnType<typeof setInterval>;

  constructor(deps: Partial<RelayDeps> = {}) {
    this.deps = { ...DEFAULT_DEPS, ...deps };
    this.limiter = new RateLimiter(this.deps.rateLimits);
  }

  /** Start the periodic idle sweep (reaps zombie phone sockets). */
  start(): void {
    if (this.idleSweepTimer) return;
    this.idleSweepTimer = setInterval(() => this.sweepIdle(), this.deps.idleSweepMs);
    this.idleSweepTimer.unref?.();
  }

  stop(): void {
    if (this.idleSweepTimer) clearInterval(this.idleSweepTimer);
    this.idleSweepTimer = undefined;
  }

  // ── Rate-limit pre-check (called by the upgrade router before accepting) ──
  /** Per-minute connect gate for a /device upgrade. False → refuse (HTTP 429). */
  allowDeviceConnect(routingId: string, clientAddress?: string): boolean {
    return this.limiter.allowConnect(routingId, this.deps.now(), clientAddress);
  }

  // ── Mac connector (/mac) ──────────────────────────────────────────────────
  async onMacConnected(ws: WebSocket, req: IncomingMessage): Promise<void> {
    const routingId = headerValue(req.headers['x-o8-routing-id']);
    if (!routingId) {
      safeClose(ws, 1008, 'missing routing id');
      return;
    }
    const bearer = stripBearer(headerValue(req.headers.authorization));
    const verdict = await this.deps.verifyPlanToken(bearer);
    if (!verdict.ok) {
      console.warn(`${P} /mac rejected routingId=${short(routingId)} reason=${verdict.reason}`);
      safeClose(ws, CLOSE.ENTITLEMENT_LAPSED, 'entitlement_lapsed');
      return;
    }
    if (!this.deps.relayOffNetwork(verdict.plan)) {
      console.warn(`${P} /mac rejected routingId=${short(routingId)} plan=${verdict.plan} not entitled`);
      safeClose(ws, CLOSE.ENTITLEMENT_LAPSED, 'entitlement_lapsed');
      return;
    }

    const superseded = this.routing.registerMac(routingId, ws, this.deps.now());
    if (superseded) {
      console.log(`${P} /mac supersede routingId=${short(routingId)}`);
      safeClose(superseded, 1001, 'superseded');
    }
    this.macRouting.set(ws, routingId);
    console.log(`${P} /mac up routingId=${short(routingId)} plan=${verdict.plan}`);

    // Wake any phones that were holding for a Mac (or re-bind on supersede): tell
    // the Mac about each stream + re-arm the handshake, and lift presence.
    for (const d of this.routing.devicesFor(routingId)) {
      d.ready = false;
      this.clearHold(d);
      this.macSend(ws, { t: 'mux-open', sid: d.sid });
      this.phoneSend(d.socket, { t: 'presence', mac: 'up' });
      this.armHandshake(d);
    }
    this.macSend(ws, { t: 'devices', count: this.routing.readyDeviceCount(routingId) });

    ws.on('message', (raw) => this.onMacMessage(ws, routingId, raw));
    ws.on('close', () => this.onMacClosed(ws, routingId));
    ws.on('error', () => {/* close handler does cleanup */});
  }

  private onMacMessage(ws: WebSocket, routingId: string, raw: unknown): void {
    const frame = decode(raw as string | Buffer);
    if (!frame) return;
    switch (frame.t) {
      case 'mux': {
        // Opaque forward Mac → phone. The relay owns the mux/sid addressing (D3); the phone
        // leg is single-stream, so deliver the payload BARE — decode the transport envelope
        // and forward the connector's raw inner frame. Symmetric with onDeviceMessage, which
        // wraps the phone's bare frames into mux toward the Mac. The relay never parses it.
        if (!isMuxFrame(frame)) return;
        const sid = typeof frame.sid === 'string' ? frame.sid : '';
        const device = this.routing.getDevice(routingId, sid);
        if (!device) return;
        device.lastActivityAt = this.deps.now();
        const payload = typeof frame.payload === 'string' ? frame.payload : '';
        if (payload) trySend(device.socket, Buffer.from(payload, 'base64').toString('utf8'));
        return;
      }
      case 'mux-close': {
        const sid = typeof frame.sid === 'string' ? frame.sid : '';
        const device = this.routing.getDevice(routingId, sid);
        if (!device) return;
        // Pass a Mac-origin 4401/4403 through unchanged; anything else → generic.
        const code = isMacOriginCloseCode(frame.code) ? frame.code : 1000;
        const reason = typeof frame.reason === 'string' ? frame.reason : undefined;
        safeClose(device.socket, code, reason);
        return;
      }
      case 'mux-ready': {
        const sid = typeof frame.sid === 'string' ? frame.sid : '';
        const device = this.routing.getDevice(routingId, sid);
        if (!device || device.ready) return;
        device.ready = true;
        device.lastActivityAt = this.deps.now();
        this.clearHandshake(device);
        this.limiter.clearPending(routingId);
        this.macSend(ws, { t: 'devices', count: this.routing.readyDeviceCount(routingId) });
        return;
      }
      case 'push-req': {
        void this.handlePushReq(frame);
        return;
      }
      default:
        return;
    }
  }

  private async handlePushReq(frame: Record<string, unknown>): Promise<void> {
    const token = typeof frame.apnsAlertToken === 'string' ? frame.apnsAlertToken : '';
    const environment = frame.environment === 'production' ? 'production' : 'sandbox';
    const kind = typeof frame.kind === 'string' ? frame.kind : 'approval';
    if (!token) return;
    if (!this.deps.apnsConfigured()) {
      console.warn(`${P} push-req dropped — APNs not configured`);
      return;
    }
    const res = await this.deps.sendApprovalAlert({ apnsAlertToken: token, environment, kind });
    console.log(`${P} push-req kind=${kind} env=${environment} ok=${res.ok}${res.reason ? ` reason=${res.reason}` : ''}`);
  }

  private onMacClosed(ws: WebSocket, routingId: string): void {
    const removed = this.routing.removeMac(routingId, ws);
    this.macRouting.delete(ws);
    if (!removed) return; // a superseded socket closing late — ignore.
    console.log(`${P} /mac down routingId=${short(routingId)}`);
    // Mac offline: presence down + hold each phone up to macOfflineHoldMs, then 4408.
    for (const d of this.routing.devicesFor(routingId)) {
      d.ready = false;
      this.clearHandshake(d);
      this.phoneSend(d.socket, { t: 'presence', mac: 'down' });
      this.armHold(d);
    }
  }

  // ── Phone (/device/{routingId}) ─────────────────────────────────────────────
  onDeviceConnected(ws: WebSocket, routingId: string): void {
    // Pending-unauth cap (per routingId). Over → 4408 backoff.
    if (!this.limiter.admitPending(routingId)) {
      safeClose(ws, CLOSE.MAC_OFFLINE, 'too_many_pending');
      return;
    }
    const sid = `s${++this.sidCounter}`;
    const now = this.deps.now();
    const entry: DeviceEntry<WebSocket> = { sid, socket: ws, admittedAt: now, lastActivityAt: now, ready: false };
    this.routing.addDevice(routingId, entry);
    const meta: DeviceMeta = { routingId, sid };
    this.deviceMeta.set(ws, meta);

    const mac = this.routing.getMac(routingId);
    if (mac) {
      this.macSend(mac, { t: 'mux-open', sid });
      this.phoneSend(ws, { t: 'presence', mac: 'up' });
      this.armHandshake(entry);
    } else {
      // Mac offline at connect: honest presence down + hold (docs §D4).
      this.phoneSend(ws, { t: 'presence', mac: 'down' });
      this.armHold(entry);
    }

    ws.on('message', (raw) => this.onDeviceMessage(ws, raw));
    ws.on('close', () => this.onDeviceClosed(ws));
    ws.on('error', () => {/* close handler does cleanup */});
  }

  private onDeviceMessage(ws: WebSocket, raw: unknown): void {
    const meta = this.deviceMeta.get(ws);
    if (!meta) return;
    const entry = this.routing.getDevice(meta.routingId, meta.sid);
    if (!entry) return;
    entry.lastActivityAt = this.deps.now();
    const mac = this.routing.getMac(meta.routingId);
    if (!mac) return; // no peer — drop; the hold timer will close the socket.
    // Opaque forward phone → Mac, adding the sid so the Mac can demux. Accept BOTH shapes:
    // a phone that already speaks the {seq,payload} mux envelope (forward as-is), or a phone
    // that sends BARE frames per the D3 "relay owns addressing" design (wrap the raw bytes).
    // Either way the relay never parses the inner content.
    const frame = decode(raw as string | Buffer);
    if (isMuxFrame(frame)) {
      this.macSend(mac, { t: 'mux', sid: meta.sid, seq: frame.seq, payload: frame.payload });
    } else {
      const rawStr = typeof raw === 'string' ? raw : Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
      this.macSend(mac, { t: 'mux', sid: meta.sid, seq: 0, payload: Buffer.from(rawStr, 'utf8').toString('base64') });
    }
  }

  private onDeviceClosed(ws: WebSocket): void {
    const meta = this.deviceMeta.get(ws);
    if (!meta) return;
    this.deviceMeta.delete(ws);
    if (meta.holdTimer) clearTimeout(meta.holdTimer);
    if (meta.handshakeTimer) clearTimeout(meta.handshakeTimer);
    const entry = this.routing.removeDevice(meta.routingId, meta.sid);
    if (entry && !entry.ready) this.limiter.clearPending(meta.routingId);
    const mac = this.routing.getMac(meta.routingId);
    if (mac) {
      this.macSend(mac, { t: 'mux-close', sid: meta.sid });
      this.macSend(mac, { t: 'devices', count: this.routing.readyDeviceCount(meta.routingId) });
    }
  }

  // ── Timers ──────────────────────────────────────────────────────────────────
  private armHandshake(entry: DeviceEntry<WebSocket>): void {
    const meta = this.deviceMeta.get(entry.socket);
    if (!meta) return;
    if (meta.handshakeTimer) clearTimeout(meta.handshakeTimer);
    meta.handshakeTimer = setTimeout(() => {
      // Never completed auth + E2EE with the Mac in time → drop (backoff).
      safeClose(entry.socket, CLOSE.MAC_OFFLINE, 'handshake_timeout');
    }, this.deps.handshakeDeadlineMs);
    meta.handshakeTimer.unref?.();
  }

  private clearHandshake(entry: DeviceEntry<WebSocket>): void {
    const meta = this.deviceMeta.get(entry.socket);
    if (meta?.handshakeTimer) {
      clearTimeout(meta.handshakeTimer);
      meta.handshakeTimer = undefined;
    }
  }

  private armHold(entry: DeviceEntry<WebSocket>): void {
    const meta = this.deviceMeta.get(entry.socket);
    if (!meta) return;
    if (meta.holdTimer) clearTimeout(meta.holdTimer);
    meta.holdTimer = setTimeout(() => {
      safeClose(entry.socket, CLOSE.MAC_OFFLINE, 'mac_offline');
    }, this.deps.macOfflineHoldMs);
    meta.holdTimer.unref?.();
  }

  private clearHold(entry: DeviceEntry<WebSocket>): void {
    const meta = this.deviceMeta.get(entry.socket);
    if (meta?.holdTimer) {
      clearTimeout(meta.holdTimer);
      meta.holdTimer = undefined;
    }
  }

  private sweepIdle(): void {
    const now = this.deps.now();
    for (const d of this.routing.allDevices()) {
      const meta = this.deviceMeta.get(d.socket);
      if (!meta) continue;
      const stale = now - d.lastActivityAt > this.deps.idleMaxMs;
      if (stale && !this.routing.hasMac(meta.routingId)) {
        safeClose(d.socket, CLOSE.MAC_OFFLINE, 'idle');
      }
    }
  }

  // ── send helpers ──
  private macSend(ws: WebSocket, frame: object): void {
    trySend(ws, encode(frame));
  }

  private phoneSend(ws: WebSocket, frame: object): void {
    trySend(ws, encode(frame));
  }

  // ── introspection (tests / /health) ──
  stats(): { macs: number; devices: number } {
    return { macs: this.macRouting.size, devices: this.deviceMeta.size };
  }
}

// ── small helpers ─────────────────────────────────────────────────────────────
function headerValue(v: string | string[] | undefined): string {
  if (Array.isArray(v)) return v[0] ?? '';
  return typeof v === 'string' ? v : '';
}

function stripBearer(v: string): string {
  return v.replace(/^Bearer\s+/i, '').trim();
}

function short(routingId: string): string {
  return routingId.length > 10 ? `${routingId.slice(0, 10)}…` : routingId;
}

function trySend(ws: WebSocket, data: string): void {
  try {
    // ws.OPEN === 1
    if (ws.readyState === 1) ws.send(data);
  } catch {
    /* peer gone */
  }
}

function safeClose(ws: WebSocket, code: number, reason?: string): void {
  try {
    ws.close(code, reason);
  } catch {
    /* already gone */
  }
}
