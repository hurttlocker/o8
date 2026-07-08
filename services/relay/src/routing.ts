/**
 * Pure in-memory routing state for the relay — NO database, NO sockets I/O here
 * (generic over the socket type `S` so it unit-tests with fakes). The relay's
 * total durable knowledge lives in these two maps: `routingId → mac socket` and
 * `routingId → {sid → device socket}`. Nothing is persisted (docs §D7).
 */

export interface MacEntry<S> {
  socket: S;
  connectedAt: number;
}

export interface DeviceEntry<S> {
  sid: string;
  socket: S;
  admittedAt: number;
  lastActivityAt: number;
  /** True once the connector signals `mux-ready` (auth + E2EE complete). */
  ready: boolean;
}

export class RoutingTable<S> {
  private macs = new Map<string, MacEntry<S>>();
  private devices = new Map<string, Map<string, DeviceEntry<S>>>();

  // ── Mac side ──
  /**
   * Register a Mac socket for a routingId. One socket per routingId; the newest
   * supersedes. Returns the superseded prior socket (caller closes it) or null.
   */
  registerMac(routingId: string, socket: S, now: number): S | null {
    const prior = this.macs.get(routingId) ?? null;
    this.macs.set(routingId, { socket, connectedAt: now });
    return prior && prior.socket !== socket ? prior.socket : null;
  }

  /** Remove a Mac socket only if it's still the current one (a superseded socket's
   *  late close must not evict the newer registration). */
  removeMac(routingId: string, socket: S): boolean {
    const cur = this.macs.get(routingId);
    if (cur && cur.socket === socket) {
      this.macs.delete(routingId);
      return true;
    }
    return false;
  }

  getMac(routingId: string): S | null {
    return this.macs.get(routingId)?.socket ?? null;
  }

  hasMac(routingId: string): boolean {
    return this.macs.has(routingId);
  }

  // ── Device side ──
  addDevice(routingId: string, entry: DeviceEntry<S>): void {
    let m = this.devices.get(routingId);
    if (!m) {
      m = new Map();
      this.devices.set(routingId, m);
    }
    m.set(entry.sid, entry);
  }

  getDevice(routingId: string, sid: string): DeviceEntry<S> | null {
    return this.devices.get(routingId)?.get(sid) ?? null;
  }

  removeDevice(routingId: string, sid: string): DeviceEntry<S> | null {
    const m = this.devices.get(routingId);
    if (!m) return null;
    const e = m.get(sid) ?? null;
    m.delete(sid);
    if (m.size === 0) this.devices.delete(routingId);
    return e;
  }

  devicesFor(routingId: string): DeviceEntry<S>[] {
    return [...(this.devices.get(routingId)?.values() ?? [])];
  }

  /** Count of READY (authed + handshake-complete) phones — the meaningful "live
   *  phones" number reported to the Mac in `devices {count}`. */
  readyDeviceCount(routingId: string): number {
    let n = 0;
    for (const e of this.devices.get(routingId)?.values() ?? []) if (e.ready) n += 1;
    return n;
  }

  allDevices(): DeviceEntry<S>[] {
    const out: DeviceEntry<S>[] = [];
    for (const m of this.devices.values()) for (const e of m.values()) out.push(e);
    return out;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
/**
 * Per-routingId anti-abuse (docs §D2 / R4). The relay authenticates NOTHING at
 * the phone leg (zero-knowledge), so abuse resistance is rate limiting only:
 *   - ≤ maxPerMin device-connect attempts per routingId (sliding 60s window)
 *   - ≤ maxPending admitted-but-not-yet-ready sockets per routingId
 * The 10s handshake deadline is enforced in relay.ts via a timer.
 */
export interface RateLimiterOpts {
  maxPerMin: number;
  maxPending: number;
  windowMs: number;
}

export const DEFAULT_RATE_LIMITS: RateLimiterOpts = {
  maxPerMin: 30,
  maxPending: 8,
  windowMs: 60_000,
};

export class RateLimiter {
  private connects = new Map<string, number[]>();
  private pending = new Map<string, number>();

  constructor(private readonly opts: RateLimiterOpts = DEFAULT_RATE_LIMITS) {}

  /** Record + check a connect attempt. Every attempt counts against the window
   *  (a rejected flood keeps itself rejected). Returns false when over the limit. */
  allowConnect(routingId: string, now: number): boolean {
    const arr = (this.connects.get(routingId) ?? []).filter((t) => now - t < this.opts.windowMs);
    arr.push(now);
    this.connects.set(routingId, arr);
    return arr.length <= this.opts.maxPerMin;
  }

  /** Reserve a pending-unauth slot at admit. Returns false when over the cap. */
  admitPending(routingId: string): boolean {
    const n = this.pending.get(routingId) ?? 0;
    if (n >= this.opts.maxPending) return false;
    this.pending.set(routingId, n + 1);
    return true;
  }

  /** Release a pending-unauth slot (on ready, close, or handshake-timeout). */
  clearPending(routingId: string): void {
    const n = this.pending.get(routingId) ?? 0;
    if (n > 0) this.pending.set(routingId, n - 1);
  }

  pendingCount(routingId: string): number {
    return this.pending.get(routingId) ?? 0;
  }
}
