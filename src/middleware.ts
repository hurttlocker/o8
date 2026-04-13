/**
 * Global API auth middleware.
 *
 * Gates the dangerous local-only API surface (panel, orchestrator, directives,
 * cortex, runtime, lanes, worktrees, review) on loopback origin + bearer token.
 *
 * This runs before any route handler, so we don't have to thread
 * `requirePanelAuth` through every route file.
 *
 * Security posture:
 *   - Requests from loopback origins (127.0.0.1, localhost, Tauri webview) pass.
 *   - Cross-origin or LAN requests must present the panel bearer token that
 *     matches the actual ws-token on disk — not just "any Bearer".
 *   - Without this, any LAN device could reach the Next dev/prod server and
 *     dispatch Codex, approve merges, etc. (See audit 2026-04-09.)
 *
 * Read routes (GET /api/panel/status etc.) are still gated. If you need a
 * public read endpoint, add it to ALLOWLIST_PATHS below.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { migrateDataDirOnce } from '@/lib/data-dir-migration';

migrateDataDirOnce();

// Middleware must run in Node runtime to read the ws-token file.
export const config = {
  matcher: ['/api/:path*'],
  runtime: 'nodejs',
};

// ── Token loader (cached, refreshed on mtime change) ──

let _cachedToken: { value: string; mtimeMs: number } | null = null;

function loadPanelToken(): string | null {
  try {
    const dataDir = process.env.CORTEX_IDE_DATA_DIR
      || join(process.env.HOME || '', '.o8');
    const tokenPath = join(dataDir, 'ws-token');
    if (!existsSync(tokenPath)) return null;

    // Cheap mtime check to avoid re-reading every request.
    const { statSync } = require('node:fs') as typeof import('node:fs');
    const stat = statSync(tokenPath);
    if (_cachedToken && _cachedToken.mtimeMs === stat.mtimeMs) {
      return _cachedToken.value;
    }

    const raw = readFileSync(tokenPath, 'utf-8').trim();
    if (!raw) return null;
    _cachedToken = { value: raw, mtimeMs: stat.mtimeMs };
    return raw;
  } catch {
    return null;
  }
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * Paths that are allowed to pass through the middleware without auth.
 * Keep this list MINIMAL. These must be safe to expose unauthenticated.
 *
 * IMPORTANT: `/api/setup/*` is ONLY allowlisted for read methods (GET/HEAD).
 * Writes (POST/PATCH/DELETE) still go through the loopback gate so a
 * cross-origin POST can't silently write to the user's Claude config or
 * flip setupComplete before the desktop app is ready.
 */
const ALLOWLIST_READ_ONLY: RegExp[] = [
  // Setup wizard reads — needs to run before any token is known.
  /^\/api\/setup(\/|$)/,
  // GitHub device flow login — must be reachable without prior auth.
  /^\/api\/panel\/github-device(\/|$)/,
  /^\/api\/panel\/github-auth(\/|$)/,
  // Health check for the Tauri shell to know the bundled server is up.
  /^\/api\/panel\/status(\/|$)/,
  // v2 auth endpoints (login, callback) must be reachable.
  /^\/api\/v2\/auth(\/|$)/,
];

const ALLOWLIST_ANY_METHOD: RegExp[] = [
  // github-device and v2/auth both need POST for the handshake.
  /^\/api\/panel\/github-device(\/|$)/,
  /^\/api\/panel\/github-auth(\/|$)/,
  /^\/api\/v2\/auth(\/|$)/,
];

/**
 * Path prefixes that require auth. Everything else (pages, static, etc.) is
 * passed through untouched. Narrow this down — don't over-gate.
 */
const GATED_PREFIXES = [
  '/api/panel/',
  '/api/orchestrator/',
  '/api/directives',
  '/api/cortex/',
  '/api/runtime/',
  '/api/lanes',
  '/api/worktrees',
  '/api/review/',
  '/api/board/',
  '/api/command-center/',
  '/api/claude-code/',
  '/api/codex/',
  '/api/operator/',
  // Setup routes are gated too — GET is allowlisted above, POST needs loopback
  // or a token (so an evil cross-origin page can't POST to /api/setup/claude-desktop
  // and silently write to the user's Claude config).
  '/api/setup/',
];

function isLoopbackHost(hostname?: string | null): boolean {
  if (!hostname) return false;
  // Normalize IPv6 brackets.
  const stripped = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
  return LOOPBACK_HOSTS.has(stripped);
}

function isTrustedLocalRequest(req: NextRequest): boolean {
  // Origin header (CORS-ish) — set by browsers, not by curl or same-origin fetches.
  const origin = req.headers.get('origin');
  if (origin) {
    try {
      const url = new URL(origin);
      if (isLoopbackHost(url.hostname)) return true;
    } catch {
      // Malformed origin — fall through.
    }
    if (origin === req.nextUrl.origin) return true;
    // Tauri webview uses `tauri://localhost` as origin.
    if (origin === 'tauri://localhost') return true;
  }

  // sec-fetch-site is set by modern browsers. same-origin/none means the
  // request came from our own page, not a cross-origin attacker.
  const fetchSite = req.headers.get('sec-fetch-site');
  if (fetchSite === 'same-origin' || fetchSite === 'none') return true;

  // Direct fetches without a browser (curl, MCP server, Node scripts) won't
  // send origin or sec-fetch-*. Accept if the request arrived on a loopback
  // interface — Next.js nextUrl.hostname reflects the Host header, which
  // matches the bound interface when the caller used 127.0.0.1/localhost.
  if (!origin && !fetchSite && isLoopbackHost(req.nextUrl.hostname)) return true;

  // Also trust the host header matching loopback (some clients set only Host).
  const host = req.headers.get('host')?.split(':')[0];
  if (!origin && !fetchSite && isLoopbackHost(host)) return true;

  return false;
}

function isAllowlisted(pathname: string, method: string): boolean {
  // Any-method allowlist (OAuth handshakes).
  if (ALLOWLIST_ANY_METHOD.some((p) => p.test(pathname))) return true;
  // Read-only allowlist — only GET/HEAD pass without auth.
  const isRead = method === 'GET' || method === 'HEAD';
  if (isRead && ALLOWLIST_READ_ONLY.some((p) => p.test(pathname))) return true;
  return false;
}

function needsGate(pathname: string): boolean {
  return GATED_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

export function middleware(req: NextRequest): NextResponse {
  const { pathname } = req.nextUrl;
  const method = req.method.toUpperCase();

  // Short-circuit: non-API requests and allowlisted paths always pass.
  if (!needsGate(pathname) || isAllowlisted(pathname, method)) {
    return NextResponse.next();
  }

  // Loopback / same-origin requests pass without a token (default case for
  // desktop app, MCP server, curl from localhost).
  if (isTrustedLocalRequest(req)) {
    return NextResponse.next();
  }

  // Bearer-token fallback for non-loopback callers (Tailscale, mobile Safari
  // hitting the dev port over LAN). The presented token MUST match the
  // panel bearer token persisted in ~/.o8/ws-token.
  const panelToken = loadPanelToken();
  if (panelToken) {
    const auth = req.headers.get('authorization');
    if (auth?.startsWith('Bearer ') && auth.slice(7).trim() === panelToken) {
      return NextResponse.next();
    }
    const queryToken = req.nextUrl.searchParams.get('token');
    if (queryToken && queryToken === panelToken) {
      return NextResponse.next();
    }
  }

  return NextResponse.json(
    {
      error: 'Unauthorized',
      detail:
        'This endpoint is restricted to local o8 clients. Requests from other origins must present a valid bearer token.',
    },
    { status: 401 },
  );
}
