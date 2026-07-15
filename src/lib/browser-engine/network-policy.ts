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
