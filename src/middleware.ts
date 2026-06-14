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
import { timingSafeEqual } from 'node:crypto';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  O8_CLIENT_ADDR_HEADER,
  hostHeaderToHostname,
  isLoopbackAddress,
  isLoopbackHostname,
} from '@/lib/auth/loopback-request';
import { migrateDataDirOnce } from '@/lib/data-dir-migration';

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
];

const ALLOWLIST_ANY_METHOD: RegExp[] = [
  // github-device and v2/auth both need POST for the handshake.
  /^\/api\/panel\/github-device(\/|$)/,
  /^\/api\/panel\/github-auth(\/|$)/,
  /^\/api\/v2\/auth(\/|$)/,
];

/**
 * Worker protocol routes are authenticated inside each handler against the
 * worker_tokens table (or, for /api/cloud/*, the cloud-workers config files).
 * Workers run off-host (customer laptops, Kubernetes, Vercel Sandbox), so the
 * loopback-origin check does not apply here and they must bypass the panel
 * ws-token gate entirely. Each handler runs its own Bearer check.
 *
 * /api/cloud/* — Cursor-style self-hosted worker pool (issue #514). Auth via
 * service-account keys in ~/.cortex-ide/cloud-workers/ via verifyCloudWorkerKey.
 * /api/worker/* — push-based remote-customer runtime (earlier work).
 */
const WORKER_PREFIXES = ['/api/worker/', '/api/cloud/'];

/**
 * Path prefixes that require auth. Everything else (pages, static, etc.) is
 * passed through untouched. Narrow this down — don't over-gate.
 */
const GATED_PREFIXES = [
  '/api/panel/',
  '/api/orchestrator/',
  // Browser-agent verb bridge (drives the embedded browser) — exact subpath
  // only: /api/browser/proxy must stay open, iframes can't send a bearer.
  '/api/browser/agent',
  // Engine tier (headless Chrome live view + verbs) — loopback img tags pass.
  '/api/browser/engine',
  // Canvas intent bus (Symon / local agents drive the canvas surface).
  '/api/canvas/',
  '/api/runtime/',
  '/api/lanes',
  '/api/worktrees',
  '/api/review/',
  '/api/board/',
  '/api/command-center/',
  '/api/claude-code/',
  '/api/codex/',
  '/api/operator/',
  // Orchestrator chat backend is local-gated here and Clerk-authenticated in
  // the route handler.
  '/api/v2/chat',
  // File read/WRITE inside registered repos (LLM chat "Apply to File").
  // Was ungated — a LAN client could edit repo files without the token.
  '/api/v2/files',
  // Cortex memory/directive surface — local-only by design. Even read-only
  // endpoints leak operator preferences and repo names; gate them too.
  '/api/cortex/',
  // Projects model (epic #899) — leaks repo names and operator-curated
  // groupings. Loopback-only with bearer-token fallback for LAN clients.
  '/api/projects',
  // Automations (Superset borrow) — reads + writes scheduled agent runs.
  // Owner emails, prompts, and dispatch can all leak; gate loopback-only.
  '/api/automations',
  // o8.md spec surface — reads/writes a repo-local file. Repo path is
  // operator-trusted; we don't expose this cross-origin without a token.
  '/api/repo-spec',
  // Dictation (transcribe + polish) hits paid OpenRouter endpoints with
  // the operator's key. Loopback-only so a LAN client can't drain credits.
  '/api/dictation/',
  // One-way beta feedback intake posts operator reports to the private team
  // webhook. Keep it same-origin/loopback so the webhook can't be abused.
  '/api/feedback/',
  // Setup routes are gated too — GET is allowlisted above, POST needs loopback
  // or a token (so an evil cross-origin page can't POST to /api/setup/claude-desktop
  // and silently write to the user's Claude config).
  '/api/setup/',
  // The ENTIRE mobile family. It includes the agent-control surface
  // (/api/mobile/action approves merges + launches workers), transcript/history
  // readers, and the token-issuing pairing endpoint. Mobile clients already
  // send `Authorization: Bearer <ws-token>` on every call (token delivered via
  // the pairing QR / loopback-embedded meta tag), so gating costs them nothing.
  // /api/mobile/push/public-key stays read-only allow-listed above.
  '/api/mobile/',
  // CLI + LLM proxies spawn agent CLIs / spend the operator's LLM keys.
  // Desktop callers are loopback; nothing legitimate calls these from LAN
  // without the token.
  '/api/v2/proxy/',
  // Connector imports (ChatGPT export upload) parse large archives in-process
  // and write profile data into the operator's Brain context.
  '/api/connectors/',
];

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

function isWorkerRoute(pathname: string): boolean {
  return WORKER_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

function optionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

/** Exported for the vitest gate suite (tests/middleware-gate.test.ts). */
export function panelGateMiddleware(req: NextRequest): NextResponse {
  const { pathname } = req.nextUrl;
  const method = req.method.toUpperCase();

  // Worker protocol uses its own bearer auth checked inside the route handler.
  // Bypass the loopback+ws-token gate.
  if (isWorkerRoute(pathname)) {
    return NextResponse.next();
  }

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
    if (auth?.startsWith('Bearer ') && tokenMatches(auth.slice(7).trim(), panelToken)) {
      return NextResponse.next();
    }
    const queryToken = req.nextUrl.searchParams.get('token');
    if (queryToken && tokenMatches(queryToken, panelToken)) {
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
