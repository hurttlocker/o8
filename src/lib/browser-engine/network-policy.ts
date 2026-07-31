import 'server-only';

import type { BrowserContext } from 'playwright-core';
import { assertPublicHttpUrl, assertPublicWebSocketUrl } from '@/lib/network/safe-url';

export const BROWSER_NETWORK_CONTEXT_OPTIONS = { serviceWorkers: 'block' as const };

/** Install the complete engine-tier egress policy before creating a page. */
export async function installBrowserNetworkPolicy(
  context: Pick<BrowserContext, 'route' | 'routeWebSocket'>,
): Promise<void> {
  // Redirects, subresources, and clicked links can otherwise pivot a public
  // page into a loopback, RFC1918, or cloud-metadata target.
  await context.route('**/*', async (route) => {
    try {
      const requestUrl = route.request().url();
      const protocol = new URL(requestUrl).protocol;
      if (protocol === 'http:' || protocol === 'https:') {
        await assertPublicHttpUrl(requestUrl);
      } else if (!['about:', 'blob:', 'data:'].includes(protocol)) {
        throw new Error('Browser request scheme is not allowed.');
      }
      await route.continue();
    } catch {
      await route.abort('blockedbyclient');
    }
  });

  // BrowserContext.route intentionally does not intercept WebSocket
  // handshakes, so connect only after this separate destination check passes.
  await context.routeWebSocket('**/*', async (route) => {
    try {
      await assertPublicWebSocketUrl(route.url());
      route.connectToServer();
    } catch {
      await route.close({ code: 1008, reason: 'Blocked by o8 network policy' });
    }
  });
}

/** Literal-loopback hosts only — no DNS involved, so nothing can rebind a
 *  name into a pass. `localhost` itself is fine to allow by name: resolving
 *  it AWAY from loopback would make the request fail this policy's intent
 *  in the caller's favor (their own dev server), not open private ranges. */
function isLoopbackLiteralHost(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '::1' || hostname === '[::1]') return true;
  return /^127(?:\.\d{1,3}){3}$/.test(hostname);
}

/**
 * Capture-tier egress policy (#1648): the whole point of `o8 packet capture`
 * is screenshotting the agent's OWN dev server on loopback, which the
 * public-egress policy above rightly blocks. This variant allows literal
 * loopback targets (page + subresources + HMR websockets) and keeps the
 * public rules for everything else — RFC1918, link-local, and cloud-metadata
 * ranges stay blocked, and file:// never passes (tighter than the retired
 * dev-browser path, which had no policy at all).
 */
export async function installCaptureNetworkPolicy(
  context: Pick<BrowserContext, 'route' | 'routeWebSocket'>,
): Promise<void> {
  await context.route('**/*', async (route) => {
    try {
      const requestUrl = route.request().url();
      const url = new URL(requestUrl);
      if (url.protocol === 'http:' || url.protocol === 'https:') {
        if (!isLoopbackLiteralHost(url.hostname)) await assertPublicHttpUrl(requestUrl);
      } else if (!['about:', 'blob:', 'data:'].includes(url.protocol)) {
        throw new Error('Browser request scheme is not allowed.');
      }
      await route.continue();
    } catch {
      await route.abort('blockedbyclient');
    }
  });

  await context.routeWebSocket('**/*', async (route) => {
    try {
      const url = new URL(route.url());
      if (!isLoopbackLiteralHost(url.hostname)) await assertPublicWebSocketUrl(route.url());
      route.connectToServer();
    } catch {
      await route.close({ code: 1008, reason: 'Blocked by o8 network policy' });
    }
  });
}
