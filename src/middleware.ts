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

import { clerkMiddleware } from '@clerk/nextjs/server';
import { NextResponse, type NextRequest } from 'next/server';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  O8_CLIENT_ADDR_HEADER,
  hostHeaderToHostname,
  isLoopbackAddress,
  isLoopbackHostname,
} from '@/lib/auth/loopback-request';
import { migrateDataDirOnce } from '@/lib/data-dir-migration';
// DB-free reader of the registry's derived active-token-hash file (#5). Importing
// this does NOT pull better-sqlite3 into the middleware bundle — it is pure fs.
import { readActiveTokenHashes } from '@/lib/mobile/device-token-file';

migrateDataDirOnce();

// Middleware must run in Node runtime to read the ws-token file.
export const config = {
  matcher: ['/api/:path*'],
  runtime: 'nodejs',
};

// ── Token loader (cached, refreshed on mtime change) ──

let _cachedToken: { value: string; mtimeMs: number; size: number } | null = null;

function loadPanelToken(): string | null {
  try {
    const dataDir = process.env.CORTEX_IDE_DATA_DIR
      || join(process.env.HOME || '', '.o8');
    const tokenPath = join(dataDir, 'ws-token');
    if (!existsSync(tokenPath)) return null;

    // Cheap stat check to avoid re-reading every request. mtime alone has
    // ~1s resolution on some filesystems — include size so a same-tick token
    // rewrite can't keep validating against the stale value.
    const stat = statSync(tokenPath);
    if (_cachedToken && _cachedToken.mtimeMs === stat.mtimeMs && _cachedToken.size === stat.size) {
      return _cachedToken.value;
    }

    const raw = readFileSync(tokenPath, 'utf-8').trim();
    if (!raw) return null;
    _cachedToken = { value: raw, mtimeMs: stat.mtimeMs, size: stat.size };
    return raw;
  } catch {
    return null;
  }
}

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
  // VAPID public key — public by definition; the mobile client needs it
  // to call pushManager.subscribe before any token handshake.
  /^\/api\/mobile\/push\/public-key(\/|$)/,
  // Backend availability is non-sensitive setup state for mobile runtime tabs.
  /^\/api\/mobile\/orchestrator\/backend-availability(\/|$)/,
];

const ALLOWLIST_ANY_METHOD: RegExp[] = [
  // github-device and v2/auth both need POST for the handshake.
  /^\/api\/panel\/github-device(\/|$)/,
  /^\/api\/panel\/github-auth(\/|$)/,
  /^\/api\/v2\/auth(\/|$)/,
  // Mobile device enrollment (#5): an UNPAIRED phone has no bearer token yet, so
  // this bootstrap POST bypasses the bearer gate. It is NOT unauthenticated — the
  // handler requires a valid single-use enroll code (and the E2EE flag) before
  // minting a per-device token.
  /^\/api\/mobile\/enroll(\/|$)/,
];

/**
 * Self-authenticating routes bypass the loopback/token gate because they are
 * reachable OFF-HOST by design and verify their own credential in the handler:
 *   /api/worker/*        — worker protocol, Bearer against the worker_tokens table.
 *   /api/cloud/*         — self-hosted worker pool, verifyCloudWorkerKey (#514).
 *   /api/github/webhook  — GitHub delivery, HMAC-SHA256 (github-broker/auth.ts).
 * EVERYTHING else under /api/* is DENIED by default (see the gate below) — there
 * is no fail-open "ungated family" any more. To expose a new route publicly, add
 * it to ALLOWLIST_READ_ONLY (GET) or, for a self-authenticating external caller,
 * here — never by omission. Full per-family rationale: docs/loopback-api.md.
 */
const SELF_AUTH_PREFIXES = ['/api/worker/', '/api/cloud/', '/api/github/webhook'];

function isTrustedLocalRequest(req: NextRequest): boolean {
  // Tier 1 — socket truth. The bundled production server stamps the real TCP
  // peer address into x-o8-client-addr on EVERY request, overwriting anything
  // the client sent (see the server.js wrapper in scripts/tauri-export.mjs).
  // When present it is authoritative: every header below (Origin, Host,
  // sec-fetch-*) is client-controlled, so a direct LAN connection can spoof
  // them all. A known-remote socket can only be authorized by the bearer token.
  const clientAddr = req.headers.get(O8_CLIENT_ADDR_HEADER);
  if (clientAddr) {
    return isLoopbackAddress(clientAddr);
  }

  // Tier 2 — dev fallback (next dev / dev-bridge run Next's stock server,
  // which doesn't stamp the header). Best-effort heuristics; a deliberate
  // spoofer on the LAN can defeat these in dev, which is the accepted
  // trade-off for keeping curl/scripts/dev-browser friction-free.

  // Origin header (CORS-ish) — set by browsers, not by curl or same-origin fetches.
  const origin = req.headers.get('origin');
  if (origin) {
    try {
      const url = new URL(origin);
      if (isLoopbackHostname(url.hostname)) return true;
    } catch {
      // Malformed origin — fall through.
    }
    // Tauri webview uses `tauri://localhost` as origin.
    // NOTE: `origin === req.nextUrl.origin` was deliberately REMOVED — a LAN
    // browser that loaded our page is same-origin too, which made the gate a
    // no-op for any phone/laptop on the network.
    if (origin === 'tauri://localhost') return true;
  }

  // sec-fetch-site from a browser is only meaningful when the page was served
  // to a loopback client — a LAN browser's fetches are same-origin as well,
  // and non-browser clients can fabricate the header. Require loopback Host.
  const fetchSite = req.headers.get('sec-fetch-site');
  if (
    (fetchSite === 'same-origin' || fetchSite === 'none')
    && isLoopbackHostname(req.nextUrl.hostname)
  ) {
    return true;
  }

  // Direct fetches without a browser (curl, MCP server, Node scripts) won't
  // send origin or sec-fetch-*. Accept if the Host targets loopback.
  if (!origin && !fetchSite && isLoopbackHostname(req.nextUrl.hostname)) return true;

  // Also trust the host header matching loopback (some clients set only Host).
  const host = hostHeaderToHostname(req.headers.get('host'));
  if (!origin && !fetchSite && isLoopbackHostname(host)) return true;

  return false;
}

/** Constant-time token comparison (length leak is fine — tokens are fixed-size). */
function tokenMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, 'utf-8');
  const b = Buffer.from(expected, 'utf-8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Per-device token (#5): accept a bearer that sha256-hashes to an ACTIVE enrolled
 * device. The hash is a one-way function and the active set is read from the
 * registry's derived file (DB-free), so no constant-time compare is needed — a
 * revoked device drops out of the set the instant the registry rewrites it.
 */
function isActiveDeviceToken(presented: string): boolean {
  if (!presented) return false;
  const hash = createHash('sha256').update(presented, 'utf-8').digest('hex');
  return readActiveTokenHashes().has(hash);
}

function isAllowlisted(pathname: string, method: string): boolean {
  // Any-method allowlist (OAuth handshakes).
  if (ALLOWLIST_ANY_METHOD.some((p) => p.test(pathname))) return true;
  // Read-only allowlist — only GET/HEAD pass without auth.
  const isRead = method === 'GET' || method === 'HEAD';
  if (isRead && ALLOWLIST_READ_ONLY.some((p) => p.test(pathname))) return true;
  return false;
}

/**
 * True for a self-authenticating route (worker protocol + HMAC webhook). Uses a
 * trailing-boundary match so a prefix entry can't accidentally cover a sibling
 * path — the structural fix for the trailing-slash gate gap (§MED-2).
 */
function isSelfAuthRoute(pathname: string): boolean {
  return SELF_AUTH_PREFIXES.some((p) =>
    p.endsWith('/') ? pathname.startsWith(p) : pathname === p || pathname.startsWith(`${p}/`),
  );
}

function optionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

/** Exported for the vitest gate suite (tests/middleware-gate.test.ts). */
export function panelGateMiddleware(req: NextRequest): NextResponse {
  const { pathname } = req.nextUrl;
  const method = req.method.toUpperCase();

  // Self-authenticating routes (worker protocol + HMAC webhook) run their own
  // auth in-handler and bypass the loopback/token gate.
  if (isSelfAuthRoute(pathname)) {
    return NextResponse.next();
  }

  // Explicit public allowlist (setup GETs, OAuth handshakes, VAPID key, enroll).
  if (isAllowlisted(pathname, method)) {
    return NextResponse.next();
  }

  // DEFAULT-DENY. The matcher restricts this middleware to /api/*, so every
  // remaining request is a state-touching API route (including app relaunch
  // requests under /api/panel/app/*). It passes ONLY from a
  // loopback origin (socket truth — desktop app, MCP server, curl from
  // localhost) or with a valid ws/device token — never by omission. This closes
  // the fail-open + trailing-slash gate class (SECURITY_AUDIT_2026-07-02
  // §HIGH-1/MED-2): an unlisted new /api/* route is denied, not exposed.
  if (isTrustedLocalRequest(req)) {
    return NextResponse.next();
  }

  // Bearer-token fallback for non-loopback callers (Tailscale, mobile Safari
  // hitting the dev port over LAN). The presented token MUST match the
  // panel bearer token persisted in ~/.o8/ws-token.
  const auth = req.headers.get('authorization');
  const bearer = auth?.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const queryToken = req.nextUrl.searchParams.get('token')?.trim() ?? '';

  const panelToken = loadPanelToken();
  if (panelToken) {
    if (bearer && tokenMatches(bearer, panelToken)) {
      return NextResponse.next();
    }
    if (queryToken && tokenMatches(queryToken, panelToken)) {
      return NextResponse.next();
    }
  }

  // Per-device token (#5) — additive, always checked (a no-op until a device
  // enrolls). Lets a per-device-token phone reach the gated mobile surface; the
  // shared ws-token above keeps desktop + legacy phones working unchanged.
  if (isActiveDeviceToken(bearer) || isActiveDeviceToken(queryToken)) {
    return NextResponse.next();
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

const clerkPublishableKey =
  optionalEnv('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY') ?? optionalEnv('CLERK_PUBLISHABLE_KEY');
const clerkSecretKey = optionalEnv('CLERK_SECRET_KEY');

// clerkMiddleware REQUIRES a secret key — with a publishable key but NO secret it
// throws on every request (verified: all gated routes 500'd, even allowlisted GETs,
// because the wrapper fails before our gate runs). The DESKTOP never ships the
// secret: Clerk runs client-side via the publishable key + the o8:// ticket flow,
// and server-side user resolution verifies the session token networklessly in the
// route handler (not via auth()/clerkMiddleware). So only wrap with clerkMiddleware
// when BOTH keys are present (the hosted/web path); otherwise — fresh install OR the
// desktop (publishable-only) — run the bare loopback gate. Clerk-gated routes like
// /api/v2/chat still fail closed inside their own handlers.
export default clerkPublishableKey && clerkSecretKey
  ? clerkMiddleware((_auth, req) => panelGateMiddleware(req), {
      publishableKey: clerkPublishableKey,
      secretKey: clerkSecretKey,
    })
  : (req: NextRequest) => panelGateMiddleware(req);
