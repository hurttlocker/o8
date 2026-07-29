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

export interface MachineEntry<S> {
  socket: S;
  accountId: string;
  installId: string;
  connectedAt: number;
}

export class MachineRoutingTable<S> {
  private machines = new Map<string, MachineEntry<S>>();
  private machineIdsByAccount = new Map<string, Set<string>>();
  private webSessions = new Map<string, Map<string, DeviceEntry<S>>>();

  registerMachine(machineId: string, entry: MachineEntry<S>): S | null {
    const prior = this.machines.get(machineId) ?? null;
    if (prior && prior.accountId !== entry.accountId) {
      this.removeAccountMachine(prior.accountId, machineId);
    }
    this.machines.set(machineId, entry);
    let accountMachines = this.machineIdsByAccount.get(entry.accountId);
    if (!accountMachines) {
      accountMachines = new Set();
      this.machineIdsByAccount.set(entry.accountId, accountMachines);
    }
    accountMachines.add(machineId);
    return prior && prior.socket !== entry.socket ? prior.socket : null;
  }

  removeMachine(machineId: string, socket: S): boolean {
    const current = this.machines.get(machineId);
    if (current?.socket !== socket) return false;
    this.machines.delete(machineId);
    this.removeAccountMachine(current.accountId, machineId);
    return true;
  }

  getMachine(machineId: string): MachineEntry<S> | null {
    return this.machines.get(machineId) ?? null;
  }

  machineIdsForAccount(accountId: string): string[] {
    return [...(this.machineIdsByAccount.get(accountId) ?? [])];
  }

  addWebSession(machineId: string, entry: DeviceEntry<S>): void {
    let sessions = this.webSessions.get(machineId);
    if (!sessions) {
      sessions = new Map();
      this.webSessions.set(machineId, sessions);
    }
    sessions.set(entry.sid, entry);
  }

  getWebSession(machineId: string, sid: string): DeviceEntry<S> | null {
    return this.webSessions.get(machineId)?.get(sid) ?? null;
  }

  removeWebSession(machineId: string, sid: string): DeviceEntry<S> | null {
    const sessions = this.webSessions.get(machineId);
    if (!sessions) return null;
    const entry = sessions.get(sid) ?? null;
    sessions.delete(sid);
    if (sessions.size === 0) this.webSessions.delete(machineId);
    return entry;
  }

  webSessionsFor(machineId: string): DeviceEntry<S>[] {
    return [...(this.webSessions.get(machineId)?.values() ?? [])];
  }

  readyWebSessionCount(machineId: string): number {
    let count = 0;
    for (const entry of this.webSessions.get(machineId)?.values() ?? []) {
      if (entry.ready) count += 1;
    }
    return count;
  }

  private removeAccountMachine(accountId: string, machineId: string): void {
    const accountMachines = this.machineIdsByAccount.get(accountId);
    if (!accountMachines) return;
    accountMachines.delete(machineId);
    if (accountMachines.size === 0) this.machineIdsByAccount.delete(accountId);
  }
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
  maxPerIpPerMin?: number;
  maxGlobalPerMin?: number;
  maxTrackedKeys?: number;
}

export const DEFAULT_RATE_LIMITS: RateLimiterOpts = {
  maxPerMin: 30,
  maxPending: 8,
  windowMs: 60_000,
  maxPerIpPerMin: 120,
  maxGlobalPerMin: 3_000,
  maxTrackedKeys: 10_000,
};

export class RateLimiter {
  private connects = new Map<string, number[]>();
  private pending = new Map<string, number>();

  constructor(private readonly opts: RateLimiterOpts = DEFAULT_RATE_LIMITS) {}

  private record(key: string, limit: number, now: number): boolean {
    const arr = (this.connects.get(key) ?? []).filter((t) => now - t < this.opts.windowMs);
    // Accepted timestamps are sufficient for an exact sliding-window limiter.
    // Once the window holds `limit` entries, every later attempt is denied
    // until one expires, so retaining denied attempts only creates unbounded
    // memory growth without changing the admission decision.
    const allowed = arr.length < limit;
    if (allowed) arr.push(now);
    this.connects.set(key, arr);

    const maxTrackedKeys = this.opts.maxTrackedKeys ?? DEFAULT_RATE_LIMITS.maxTrackedKeys!;
    if (this.connects.size > maxTrackedKeys) {
      let oldestKey: string | null = null;
      let oldest = Number.POSITIVE_INFINITY;
      for (const [candidate, times] of this.connects) {
        if (candidate === 'global') continue;
        const last = times.at(-1) ?? 0;
        if (last < oldest) {
          oldest = last;
          oldestKey = candidate;
        }
      }
      if (oldestKey) this.connects.delete(oldestKey);
    }
    return allowed;
  }

  /** Record + check routing-id, source-IP, and global connect windows. Every
   * attempt counts even after one dimension is over limit, so rotating routing
   * ids cannot bypass the relay's aggregate admission ceiling. */
  allowConnect(routingId: string, now: number, clientAddress = 'unknown'): boolean {
    const routeAllowed = this.record(`route:${routingId}`, this.opts.maxPerMin, now);
    const ipAllowed = this.record(
      `ip:${clientAddress}`,
      this.opts.maxPerIpPerMin ?? DEFAULT_RATE_LIMITS.maxPerIpPerMin!,
      now,
    );
    const globalAllowed = this.record(
      'global',
      this.opts.maxGlobalPerMin ?? DEFAULT_RATE_LIMITS.maxGlobalPerMin!,
      now,
    );
    return routeAllowed && ipAllowed && globalAllowed;
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
    if (n > 1) this.pending.set(routingId, n - 1);
    else this.pending.delete(routingId);
  }

  pendingCount(routingId: string): number {
    return this.pending.get(routingId) ?? 0;
  }
}
