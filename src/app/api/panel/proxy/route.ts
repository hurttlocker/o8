import { NextRequest, NextResponse } from 'next/server';

/**
 * Proxy localhost dev servers, stripping frame-busting headers.
 * Usage: /api/panel/proxy?url=http://localhost:3500/some/path
 *
 * This allows previewing localhost apps that set X-Frame-Options: DENY
 * (common with auth providers like Clerk, NextAuth, etc.)
 */
export async function GET(req: NextRequest) {
  const targetUrl = req.nextUrl.searchParams.get('url');
  if (!targetUrl) {
    return NextResponse.json({ error: 'Missing url param' }, { status: 400 });
  }

  // Security: only proxy localhost/127.0.0.1
  try {
    const parsed = new URL(targetUrl);
    const host = parsed.hostname;
    if (host !== 'localhost' && host !== '127.0.0.1' && host !== '0.0.0.0') {
      return NextResponse.json({ error: 'Only localhost URLs allowed' }, { status: 403 });
    }
  } catch {
    return NextResponse.json({ error: 'Invalid URL' }, { status: 400 });
  }

  try {
    const upstream = await fetch(targetUrl, {
      headers: {
        // Forward accept headers for proper content negotiation
        'Accept': req.headers.get('accept') ?? 'text/html,*/*',
        'Accept-Encoding': 'identity', // avoid compressed responses we'd need to decompress
      },
      redirect: 'follow',
    });

    // Clone response and strip frame-busting headers
    const headers = new Headers(upstream.headers);
    headers.delete('x-frame-options');
    headers.delete('content-security-policy');
    headers.delete('content-security-policy-report-only');

    // Rewrite absolute URLs in HTML to go through proxy
    const contentType = headers.get('content-type') ?? '';
    let body: ReadableStream | ArrayBuffer | null = null;

    if (contentType.includes('text/html')) {
      let html = await upstream.text();
      // Inject <base> tag so relative URLs (JS, CSS, images) resolve to the dev server
      const parsed = new URL(targetUrl);
      const baseUrl = `${parsed.protocol}//${parsed.host}`;
      html = html.replace(/<head([^>]*)>/i, `<head$1><base href="${baseUrl}/">`);
      return new NextResponse(html, {
        status: upstream.status,
        headers,
      });
    }

    // Non-HTML: stream through directly
    return new NextResponse(upstream.body, {
      status: upstream.status,
      headers,
    });
  } catch (err) {
    return NextResponse.json(
      { error: `Proxy error: ${err instanceof Error ? err.message : 'unknown'}` },
      { status: 502 }
    );
  }
}
