import { NextResponse } from 'next/server';
import { createElementPickerBridgeScript } from '@/lib/browser/element-picker-bridge';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * iframe-proxy — Serves a localhost dev server through our own origin so the
 * O8 Browser pane can inject the element-picker bridge script into it.
 *
 * Why: the browser pane runs inside the dashboard at (e.g.) http://localhost:3010,
 * while the user's dev server is at http://localhost:3000. Different ports =
 * different origins = the parent can't touch the iframe's document to inject
 * the picker bridge. Routing the iframe's initial HTML through this route
 * gives it our origin, which lets the bridge install and postMessage back up.
 *
 * Safety: only localhost/127.0.0.1/0.0.0.0 targets are allowed. This is a dev
 * convenience, not a general-purpose web proxy. The route returns 400 for
 * anything that isn't an http(s) loopback URL.
 */

function isLoopbackTarget(urlString: string): URL | null {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const host = url.hostname;
  if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host === '::1') {
    return url;
  }
  // Also allow private ranges that are common for LAN dev servers.
  if (/^10\./.test(host)) return url;
  if (/^192\.168\./.test(host)) return url;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) return url;
  return null;
}

function rewriteHtml(html: string, targetUrl: URL, pickMode: boolean): string {
  let output = html;

  // Pick mode: strip every <script> tag in the page. The initial SSR DOM still
  // renders; the element picker bridge is the ONLY JS that runs. This is the
  // only way to safely proxy a hydration-heavy framework like Next.js without
  // triggering its "Application error" boundary (which fires when Next's
  // runtime starts and discovers window.location is not the origin it served
  // from, or when /_next/data/* fetches go cross-origin and CORS-fail).
  if (pickMode) {
    output = output.replace(/<script\b[\s\S]*?<\/script>/gi, '<!-- o8-picker: script removed -->');
  }

  const bridge = createElementPickerBridgeScript();
  // Base href so relative URLs (images, css) still resolve against the
  // original dev server. Ends with a trailing slash at the directory level.
  const base = `${targetUrl.origin}${targetUrl.pathname.replace(/[^/]*$/, '')}`;
  const injection = [
    `<base href="${base}">`,
    `<script data-o8-picker-bridge="true" id="o8-picker-bridge">${bridge}</script>`,
  ].join('');

  // Prefer injecting just after <head> so <base> wins over later tags.
  const headMatch = output.match(/<head[^>]*>/i);
  if (headMatch) {
    const idx = (headMatch.index ?? 0) + headMatch[0].length;
    return output.slice(0, idx) + injection + output.slice(idx);
  }
  // No <head> → prepend. This is already a malformed page, but we do our best.
  return injection + output;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const target = searchParams.get('url');
  const pickMode = searchParams.get('pick') === '1';
  if (!target) {
    return NextResponse.json({ error: 'Missing url param' }, { status: 400 });
  }
  const targetUrl = isLoopbackTarget(target);
  if (!targetUrl) {
    return NextResponse.json(
      { error: 'Proxy only supports loopback / private-network targets' },
      { status: 400 },
    );
  }

  let upstream: Response;
  try {
    upstream = await fetch(targetUrl.toString(), {
      method: 'GET',
      headers: {
        // Forward accept so the dev server knows we want HTML when applicable.
        Accept: request.headers.get('accept') ?? 'text/html,*/*',
        'User-Agent': 'o8-iframe-proxy',
      },
      // Follow redirects so /foo → /foo/ works.
      redirect: 'follow',
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Unable to reach target',
      },
      { status: 502 },
    );
  }

  const contentType = upstream.headers.get('content-type') ?? 'application/octet-stream';
  const isHtml = contentType.toLowerCase().includes('text/html');

  if (!isHtml) {
    // Stream non-HTML responses straight through — images, JSON, JS, etc.
    const body = await upstream.arrayBuffer();
    return new NextResponse(body, {
      status: upstream.status,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'no-store',
      },
    });
  }

  const originalHtml = await upstream.text();
  const rewritten = rewriteHtml(originalHtml, targetUrl, pickMode);

  return new NextResponse(rewritten, {
    status: upstream.status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      // We want this to render inside our own dashboard iframe — no need to
      // forward the upstream's X-Frame-Options / CSP frame-ancestors headers.
      'X-Frame-Options': 'SAMEORIGIN',
    },
  });
}
