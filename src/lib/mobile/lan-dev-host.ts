/**
 * Returns true when the URL points at a host the user could plausibly be
 * dev-running on the same LAN. Defense-in-depth — even an authorized
 * caller cannot push https://example.com onto the phone.
 *
 * Allowed:
 *   - http(s)://localhost(:port)
 *   - http(s)://127.0.0.1(:port)
 *   - http(s)://10.x.x.x(:port)
 *   - http(s)://172.16.x.x – 172.31.x.x(:port)
 *   - http(s)://192.168.x.x(:port)
 *   - http(s)://100.64.x.x – 100.127.x.x(:port) (Tailscale)
 *   - http(s)://*.local or *.localhost (mDNS / dev hostnames)
 *   - http(s)://*.ts.net (Tailscale MagicDNS)
 *   - http(s)://[::1] (IPv6 loopback)
 *
 * Lives in `lib/` rather than the route file because Next.js App Router
 * disallows arbitrary exports from `route.ts` (only specific symbols like
 * GET/POST/dynamic/etc. are valid Route exports).
 */
export function isLanDevHost(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return false;
  }

  const rawHost = parsed.hostname.toLowerCase();
  const host = rawHost.startsWith('[') && rawHost.endsWith(']')
    ? rawHost.slice(1, -1)
    : rawHost;

  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.ts.net')
  ) {
    return true;
  }

  if (host === '::1') return true;
  if (host === '127.0.0.1' || host.startsWith('127.')) return true;
  if (host.startsWith('10.')) return true;
  if (host.startsWith('192.168.')) return true;
  if (isTailscaleIp(host)) return true;

  if (host.startsWith('172.')) {
    const parts = host.split('.');
    if (parts.length === 4) {
      const second = Number.parseInt(parts[1], 10);
      if (Number.isFinite(second) && second >= 16 && second <= 31) {
        return true;
      }
    }
  }

  return false;
}

function isTailscaleIp(host: string): boolean {
  const parts = host.split('.').map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) {
    return false;
  }
  return parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
}
