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

import { NextResponse } from 'next/server';
import { pickLanIp } from '@/lib/panel/lan-ip';

interface LanHostResponse {
  lanIp: string | null;
  ports: number[];
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
      { windowsHide: true, encoding: 'utf-8', timeout: 3000 },
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
