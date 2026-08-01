import 'server-only';

import type { BrowserContext } from 'playwright-core';
import { isIP } from 'node:net';
import { assertPublicHttpUrl, assertPublicWebSocketUrl, isPublicNetworkAddress } from '@/lib/network/safe-url';

export const BROWSER_NETWORK_CONTEXT_OPTIONS = { serviceWorkers: 'block' as const };
export type BrowserNetworkPolicyId = 'public' | 'capture';
export interface BrowserResolvedAddress { address: string; family: number }

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

/** Exact loopback targets allowed by capture contexts. The connection proxy
 *  resolves `localhost` once and requires every answer to remain loopback. */
export function isLoopbackLiteralHost(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '::1' || hostname === '[::1]') return true;
  return /^127(?:\.\d{1,3}){3}$/.test(hostname);
}

function isLoopbackNetworkAddress(address: string): boolean {
  const normalized = address.toLowerCase().split('%')[0];
  if (normalized === '::1') return true;
  if (isIP(normalized) === 4) return /^127(?:\.\d{1,3}){3}$/.test(normalized);
  const mapped = normalized.match(/^::ffff:(127\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  return Boolean(mapped);
}

/** Validate the exact DNS answers the connection-level proxy will dial. */
export function assertBrowserResolvedAddresses(
  policy: BrowserNetworkPolicyId,
  hostname: string,
  addresses: BrowserResolvedAddress[],
): void {
  if (addresses.length === 0) throw new Error('Browser proxy DNS resolution returned no addresses.');
  const normalizedHost = hostname.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');
  const allowed = policy === 'capture' && isLoopbackLiteralHost(normalizedHost)
    ? addresses.every(({ address }) => isLoopbackNetworkAddress(address))
    : addresses.every(({ address }) => isPublicNetworkAddress(address));
  if (!allowed) throw new Error('Browser proxy refused a private or non-routable connection address.');
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
