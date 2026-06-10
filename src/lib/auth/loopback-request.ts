/**
 * Loopback-request detection shared by the middleware gate and any server
 * component that must decide whether a request came from this machine.
 *
 * Two tiers of evidence:
 *
 * 1. `x-o8-client-addr` — stamped by the bundled production server
 *    (out/server/server.js wrapper, see scripts/tauri-export.mjs) with the
 *    REAL TCP peer address on every request, overwriting any client-supplied
 *    value. When present it is authoritative: Host/Origin/sec-fetch-* are all
 *    client-controlled and spoofable by a direct LAN connection.
 *
 * 2. Host-header heuristic — dev fallback only (`next dev` / dev-bridge run
 *    Next's stock server which doesn't stamp the header). A direct client can
 *    spoof Host, so this tier is best-effort.
 */

export const O8_CLIENT_ADDR_HEADER = 'x-o8-client-addr';

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** True when a raw socket address (req.socket.remoteAddress) is loopback. */
export function isLoopbackAddress(addr?: string | null): boolean {
  if (!addr) return false;
  // Node reports IPv4-mapped IPv6 as ::ffff:127.0.0.1.
  const stripped = addr.startsWith('::ffff:') ? addr.slice(7) : addr;
  return stripped === '::1' || stripped === '127.0.0.1' || stripped.startsWith('127.');
}

/** True when a Host-style hostname (no port) is loopback. */
export function isLoopbackHostname(hostname?: string | null): boolean {
  if (!hostname) return false;
  const stripped = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
  return LOOPBACK_HOSTNAMES.has(stripped);
}

/**
 * Decide loopback-ness from request headers. `get` abstracts over
 * NextRequest.headers / next/headers so both middleware and server
 * components can share the logic.
 */
export function headersIndicateLoopback(get: (name: string) => string | null): boolean {
  const clientAddr = get(O8_CLIENT_ADDR_HEADER);
  if (clientAddr) return isLoopbackAddress(clientAddr);
  const host = get('host')?.split(':')[0] ?? null;
  return isLoopbackHostname(host);
}
