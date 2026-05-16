// LAN IP discovery — answers "what address can a phone on the same network
// reach this Mac at?"
//
// Extracted from /api/panel/lan-host so the mobile-pairing route can emit the
// same address into its QR payload without duplicating the interface-ranking
// logic. Two callers now: the DevHostFrame URL bar and the QR pairing emitter.

import os from 'node:os';

/**
 * Pick the first non-loopback IPv4 in 10/8, 172.16/12, or 192.168/16.
 *
 * The order of preference matches what people actually see at home/office:
 *   - 192.168.x.x (most home routers)
 *   - 10.x.x.x (some corporate networks, Tailscale CGNAT)
 *   - 172.16-31.x.x (Docker/some corporate networks)
 *
 * Interface names are sorted so "en0" beats "utun*" tunnels — the user's
 * physical Wi-Fi/Ethernet is what their phone can actually reach.
 *
 * Returns null when no private-range interface exists (e.g., offline).
 */
export function pickLanIp(): string | null {
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
