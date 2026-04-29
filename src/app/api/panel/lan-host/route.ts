/**
 * LAN host discovery for the mobile DevHostFrame.
 *
 * Returns the first non-loopback IPv4 address in a private RFC1918 range
 * (10/8, 172.16/12, 192.168/16) and the list of LAN-reachable dev ports.
 *
 * Used by the right-side iframe in the mobile landscape split shell to
 * default the URL bar to `http://{lanIp}:{focusedPort}` so the user can
 * reach their localhost dev server from their phone over the same network.
 *
 * Gated under `/api/panel/*` middleware (loopback or ws-token bearer).
 */

export const dynamic = 'force-dynamic';

import os from 'node:os';
import { NextResponse } from 'next/server';

interface LanHostResponse {
  lanIp: string | null;
  ports: number[];
}

/**
 * Pick the first non-loopback IPv4 in 10/8, 172.16/12, or 192.168/16.
 *
 * The order of preference matches what people actually see at home/office:
 *   - 192.168.x.x (most home routers)
 *   - 10.x.x.x (some corporate networks, Tailscale CGNAT)
 *   - 172.16-31.x.x (Docker/some corporate networks)
 *
 * We sort interface names so "en0" beats "utun*" tunnels — the user's
 * physical Wi-Fi/Ethernet is what their phone can actually reach.
 */
function pickLanIp(): string | null {
  const ifaces = os.networkInterfaces();
  const candidates: { iface: string; address: string; rank: number }[] = [];

  for (const [name, addrs] of Object.entries(ifaces)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.family !== 'IPv4') continue;
      if (addr.internal) continue;
      const ip = addr.address;
      const rank = privateRangeRank(ip);
      if (rank === 0) continue;
      candidates.push({ iface: name, address: ip, rank });
    }
  }

  if (candidates.length === 0) return null;

  // Sort: highest rank first (192.168 > 10 > 172.16), then by interface
  // name (en* before utun*) so VPN tunnels lose to physical interfaces.
  candidates.sort((a, b) => {
    if (b.rank !== a.rank) return b.rank - a.rank;
    return interfacePriority(a.iface) - interfacePriority(b.iface);
  });

  return candidates[0].address;
}

function privateRangeRank(ip: string): number {
  // 192.168.0.0/16 — home routers, return highest rank.
  if (ip.startsWith('192.168.')) return 3;
  // 10.0.0.0/8 — many corporate networks, also Tailscale's 100.64/10 sits
  // in CGNAT but starts with "100." so it falls through naturally.
  if (ip.startsWith('10.')) return 2;
  // 172.16.0.0/12 — second octet must be 16-31.
  if (ip.startsWith('172.')) {
    const parts = ip.split('.');
    if (parts.length < 2) return 0;
    const second = parseInt(parts[1], 10);
    if (Number.isFinite(second) && second >= 16 && second <= 31) return 1;
  }
  return 0;
}

function interfacePriority(name: string): number {
  // Lower = preferred. Physical interfaces beat tunnels.
  if (name.startsWith('en')) return 0;
  if (name.startsWith('eth')) return 0;
  if (name.startsWith('wl')) return 1;
  if (name.startsWith('bridge')) return 5;
  if (name.startsWith('utun')) return 8;
  if (name.startsWith('tun')) return 8;
  return 4;
}

/**
 * Read LAN-reachable dev ports by reusing the same scan that powers the
 * desktop port-hover popover. We skip the full HTTP roundtrip and call
 * lsof directly here — the panel/ports route already does this and the
 * extra HTTP call from a server route to itself just doubles the work.
 *
 * For v1 we keep the scan minimal: any registered repo's listening port
 * counts. The DevHostFrame uses these as typeahead suggestions, not as
 * a strict whitelist.
 */
async function scanDevPorts(): Promise<number[]> {
  // Lazy-import the panel ports scanner — fall back gracefully if the
  // route module shape changes; an empty list is a valid response.
  try {
    // The panel/ports route holds an internal cache, but it's not exported.
    // For now, do a thin lsof scan inline. If this ever grows we can extract
    // a shared helper — single use-case here.
    const { execSync } = await import('node:child_process');
    const raw = execSync(
      'lsof -i -P -n -sTCP:LISTEN -F pn 2>/dev/null',
      { encoding: 'utf-8', timeout: 3000 },
    ).trim();

    const ports = new Set<number>();
    for (const line of raw.split('\n')) {
      if (!line.startsWith('n')) continue;
      const match = line.match(/:(\d+)$/);
      if (!match) continue;
      const port = parseInt(match[1], 10);
      if (!Number.isFinite(port)) continue;
      // Skip well-known system ports — phone won't want to browse SSH.
      if (port < 1024) continue;
      // Skip mDNS/system-ish ranges that aren't dev servers.
      if (port === 5000 || port === 5353 || port === 7000) continue;
      ports.add(port);
    }
    return [...ports].sort((a, b) => a - b);
  } catch {
    return [];
  }
}

export async function GET(): Promise<NextResponse<LanHostResponse>> {
  const lanIp = pickLanIp();
  const ports = await scanDevPorts();
  return NextResponse.json({ lanIp, ports });
}
