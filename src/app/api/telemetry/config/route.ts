/**
 * GET /api/telemetry/config — the webview's Sentry bootstrap.
 *
 * Returns the resolved Sentry runtime config: the baked DSN (only ever non-empty
 * in a PACKAGED build — dev returns ''), the "Crash & error reports" toggle, the
 * app version (release), plan, and a `founder` BOOLEAN (never the operator
 * number). The webview (sentry-browser.ts) inits @sentry/browser only when `dsn`
 * is non-empty and re-polls this route to honor the toggle within ~30s.
 *
 * Gated by the default-deny middleware (loopback / ws-token) like every other
 * /api route — the webview is loopback so it passes; no allowlist entry. Carries
 * NO identity: no user id, no email, no machine name. NEVER throws.
 */

import { NextResponse } from 'next/server';

import { resolveSentryConfig } from '@/lib/telemetry/sentry-config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store, max-age=0' };

const DORMANT = {
  dsn: '',
  enabled: false,
  release: 'unknown',
  environment: 'production',
  plan: 'free',
  founder: false,
};

export async function GET() {
  try {
    const cfg = resolveSentryConfig();
    return NextResponse.json(
      {
        dsn: cfg.dsn,
        enabled: cfg.enabled,
        release: cfg.release,
        environment: cfg.environment,
        plan: cfg.plan,
        founder: cfg.founder,
      },
      { headers: NO_STORE },
    );
  } catch {
    // Structured fallback — never throw out of an API route. Dormant is safe.
    return NextResponse.json(DORMANT, { status: 200, headers: NO_STORE });
  }
}
