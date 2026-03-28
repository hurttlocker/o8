import { NextRequest, NextResponse } from 'next/server';

const PANEL_API_TOKEN = process.env.WS_TOKEN?.trim() || '';
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

function isLoopbackHost(hostname?: string | null) {
  if (!hostname) return false;
  return LOOPBACK_HOSTS.has(hostname);
}

export function isTrustedPanelRequest(req: NextRequest) {
  const origin = req.headers.get('origin');
  if (origin) {
    try {
      const url = new URL(origin);
      if (isLoopbackHost(url.hostname)) return true;
    } catch {
      // Ignore malformed origins and fall through to other checks.
    }

    if (origin === req.nextUrl.origin) return true;
  }

  const fetchSite = req.headers.get('sec-fetch-site');
  if (fetchSite === 'same-origin' || fetchSite === 'none') return true;

  // Some local desktop/Tauri requests omit browser fetch headers entirely.
  if (!origin && !fetchSite && isLoopbackHost(req.nextUrl.hostname)) return true;

  return false;
}

export function requirePanelAuth(req: NextRequest): NextResponse | null {
  if (isTrustedPanelRequest(req)) {
    return null;
  }

  const auth = req.headers.get('authorization');
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : req.nextUrl.searchParams.get('token');
  if (!PANEL_API_TOKEN || token !== PANEL_API_TOKEN) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return null;
}
