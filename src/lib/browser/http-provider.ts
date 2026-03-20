import type { BrowserProvider } from '@/lib/browser/provider';
import type { BrowserInventorySnapshot, BrowserProviderId, BrowserSurfaceSummary } from '@/lib/browser/types';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1']);

export function parseLocalDiscoveryUrl(rawUrl?: string) {
  if (!rawUrl) return null;

  try {
    const parsed = new URL(rawUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    if (!LOCAL_HOSTS.has(parsed.hostname)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function normalizeSurface(providerId: BrowserProviderId, surface: BrowserSurfaceSummary): BrowserSurfaceSummary {
  return {
    ...surface,
    provider: providerId,
  };
}

export function createHttpBrowserProvider({
  id,
  displayName,
  discoveryUrlEnv,
}: {
  id: BrowserProviderId;
  displayName: string;
  discoveryUrlEnv: string;
}): BrowserProvider {
  return {
    id,
    displayName,

    async discoverSurfaces() {
      const discoveryUrl = parseLocalDiscoveryUrl(process.env[discoveryUrlEnv]);
      if (!discoveryUrl) return [];

      try {
        const response = await fetch(discoveryUrl, {
          signal: AbortSignal.timeout(1500),
          cache: 'no-store',
        });
        if (!response.ok) return [];

        const payload = (await response.json().catch(() => null)) as BrowserInventorySnapshot | BrowserSurfaceSummary[] | null;
        const surfaces = Array.isArray(payload)
          ? payload
          : Array.isArray(payload?.surfaces)
            ? payload.surfaces
            : [];

        return surfaces.map((surface) => normalizeSurface(id, surface));
      } catch {
        return [];
      }
    },
  };
}
