import type { BrowserProvider } from '@/lib/browser/provider';
import type { BrowserSurfaceSummary } from '@/lib/browser/types';
import { getSessionObservableState } from '@/lib/openclaw/chat';
import { getGatewayStatus } from '@/lib/openclaw/gateway-client';

type OpenClawRecentSession = {
  key?: string;
  updatedAt?: number;
};

function dedupeSurfaces(surfaces: BrowserSurfaceSummary[]) {
  const seen = new Map<string, BrowserSurfaceSummary>();

  for (const surface of surfaces) {
    const existing = seen.get(surface.id);
    if (!existing) {
      seen.set(surface.id, surface);
      continue;
    }

    const existingTs = existing.lastActionAt ?? 0;
    const nextTs = surface.lastActionAt ?? 0;
    if (nextTs >= existingTs) {
      seen.set(surface.id, surface);
    }
  }

  return [...seen.values()];
}

const BROWSER_DISCOVERY_TTL_MS = 8_000;
let browserSurfaceCache: { surfaces: BrowserSurfaceSummary[]; cachedAt: number } | null = null;
let browserSurfaceInflight: Promise<BrowserSurfaceSummary[]> | null = null;

export const openclawBrowserProvider: BrowserProvider = {
  id: 'openclaw',
  displayName: 'OpenClaw browser mirror',

  async discoverSurfaces() {
    const now = Date.now();
    if (browserSurfaceCache && (now - browserSurfaceCache.cachedAt) < BROWSER_DISCOVERY_TTL_MS) {
      return browserSurfaceCache.surfaces;
    }

    if (browserSurfaceInflight) return browserSurfaceInflight;

    browserSurfaceInflight = (async () => {
      try {
        const status = await getGatewayStatus();
        const recentSessions = (status.sessions?.recent ?? [])
          .map((entry) => entry as OpenClawRecentSession)
          .filter((entry): entry is OpenClawRecentSession & { key: string } => typeof entry.key === 'string' && entry.key.length > 0)
          .slice(0, 8);

        const observableStates = await Promise.all(
          recentSessions.map((session) => getSessionObservableState(session.key).catch(() => ({ activity: undefined, browserSurface: undefined }))),
        );

        const surfaces = observableStates.flatMap((state, index) => {
            const surface = state.browserSurface;
            if (!surface || surface.provider !== 'openclaw') return [];
            return [{
              ...surface,
              sessionKey: surface.sessionKey ?? recentSessions[index].key,
              lastActionAt: surface.lastActionAt ?? recentSessions[index].updatedAt,
            } satisfies BrowserSurfaceSummary];
          });

        const deduped = dedupeSurfaces(surfaces);
        browserSurfaceCache = { surfaces: deduped, cachedAt: Date.now() };
        return deduped;
      } finally {
        browserSurfaceInflight = null;
      }
    })();

    return browserSurfaceInflight;
  },
};
