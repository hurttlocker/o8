import type { BrowserProvider } from '@/lib/browser/provider';
import type {
  BrowserAttachmentPage,
  BrowserAttachmentSummary,
  BrowserSurfaceSummary,
} from '@/lib/browser/types';
import { parseLocalDiscoveryUrl } from '@/lib/browser/http-provider';

const DEFAULT_CDP_DISCOVERY_URL = 'http://127.0.0.1:9222';

type CdpVersionResponse = {
  Browser?: string;
  webSocketDebuggerUrl?: string;
};

type CdpTarget = {
  id?: string;
  title?: string;
  type?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
  devtoolsFrontendUrl?: string;
};

function discoveryBaseUrl() {
  return parseLocalDiscoveryUrl(process.env.CORTEX_BROWSER_CDP_DISCOVERY_URL || DEFAULT_CDP_DISCOVERY_URL);
}

function statusForTarget(target: CdpTarget): BrowserSurfaceSummary['status'] {
  const url = target.url?.trim();
  if (!url || url === 'about:blank' || url.startsWith('chrome://newtab')) return 'idle';
  return 'active';
}

function normalizeBrowserName(raw?: string) {
  if (!raw) return 'Chrome';
  return raw.replace(/\s+/g, ' ').trim();
}

function extractBrowserVersion(raw?: string) {
  if (!raw) return undefined;
  const match = raw.match(/\/(.+)$/);
  return match?.[1] ?? raw;
}

function mapTarget(baseUrl: URL, version: CdpVersionResponse, target: CdpTarget): BrowserSurfaceSummary | null {
  if (!target.id || target.type !== 'page') return null;

  const browserName = normalizeBrowserName(version.Browser);
  return {
    id: `cdp:${target.id}`,
    provider: 'cdp',
    ownership: 'discovered',
    status: statusForTarget(target),
    sourceLabel: `Chrome DevTools remote debugging • ${baseUrl.origin}`,
    browserName,
    browserSessionId: version.webSocketDebuggerUrl,
    pageId: target.id,
    url: target.url,
    title: target.title || target.url || 'Untitled page',
    attachUrl: target.webSocketDebuggerUrl,
    lastAction: 'page discovered',
    capabilities: {
      attach: Boolean(target.webSocketDebuggerUrl),
      liveViewport: false,
      inspectDom: true,
      selectElement: false,
      controlledNavigation: false,
      screenshots: true,
      persistentProfile: false,
    },
  };
}

function mapAttachmentPage(target: CdpTarget): BrowserAttachmentPage | null {
  if (!target.id) return null;
  return {
    id: target.id,
    title: target.title || target.url || 'Untitled page',
    url: target.url,
    type: target.type,
    attachUrl: target.webSocketDebuggerUrl,
    status: statusForTarget(target),
  };
}

async function loadCdpSnapshot(baseUrl: URL) {
  const [versionResponse, listResponse] = await Promise.all([
    fetch(new URL('/json/version', baseUrl), {
      signal: AbortSignal.timeout(1200),
      cache: 'no-store',
    }),
    fetch(new URL('/json/list', baseUrl), {
      signal: AbortSignal.timeout(1200),
      cache: 'no-store',
    }),
  ]);

  if (!versionResponse.ok || !listResponse.ok) return null;

  const version = (await versionResponse.json().catch(() => null)) as CdpVersionResponse | null;
  const targets = (await listResponse.json().catch(() => null)) as CdpTarget[] | null;
  if (!version || !Array.isArray(targets)) return null;

  return { version, targets };
}

export const cdpBrowserProvider: BrowserProvider = {
  id: 'cdp',
  displayName: 'Chrome DevTools discovery',

  async discoverSurfaces() {
    const baseUrl = discoveryBaseUrl();
    if (!baseUrl) return [];

    try {
      const snapshot = await loadCdpSnapshot(baseUrl);
      if (!snapshot) return [];

      return snapshot.targets
        .map((target) => mapTarget(baseUrl, snapshot.version, target))
        .filter((surface): surface is BrowserSurfaceSummary => Boolean(surface));
    } catch {
      return [];
    }
  },

  async attachSurface(surfaceId: string): Promise<BrowserAttachmentSummary> {
    const baseUrl = discoveryBaseUrl();
    if (!baseUrl) {
      throw new Error('CDP discovery URL is unavailable. Set CORTEX_BROWSER_CDP_DISCOVERY_URL or use the default Chrome remote debugging port.');
    }

    let snapshot: Awaited<ReturnType<typeof loadCdpSnapshot>>;
    try {
      snapshot = await loadCdpSnapshot(baseUrl);
    } catch {
      throw new Error(`Unable to reach Chrome DevTools at ${baseUrl.origin}. Start Chrome with --remote-debugging-port=9222 or point CORTEX_BROWSER_CDP_DISCOVERY_URL at a live localhost endpoint.`);
    }
    if (!snapshot) {
      throw new Error(`Unable to reach Chrome DevTools at ${baseUrl.origin}. Start Chrome with --remote-debugging-port=9222 or point CORTEX_BROWSER_CDP_DISCOVERY_URL at a live localhost endpoint.`);
    }

    const targetId = surfaceId.replace(/^cdp:/, '');
    const currentTarget = snapshot.targets.find((target) => target.id === targetId && target.type === 'page');
    if (!currentTarget) {
      throw new Error('Requested CDP page is no longer available.');
    }

    const surface = mapTarget(baseUrl, snapshot.version, currentTarget);
    if (!surface) {
      throw new Error('Unable to normalize the requested CDP page.');
    }

    return {
      attachedAt: new Date().toISOString(),
      provider: 'cdp',
      surface,
      browserName: normalizeBrowserName(snapshot.version.Browser),
      browserVersion: extractBrowserVersion(snapshot.version.Browser),
      note: 'Read-only attach established through Chrome DevTools discovery. No browser control is sent yet.',
      pages: snapshot.targets
        .map((target) => mapAttachmentPage(target))
        .filter((page): page is BrowserAttachmentPage => Boolean(page)),
    };
  },
};
