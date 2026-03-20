import { cdpBrowserProvider } from '@/lib/browser/cdp';
import type { BrowserProvider } from '@/lib/browser/provider';
import { playwrightBrowserProvider } from '@/lib/browser/playwright';
import type { BrowserInventorySnapshot, BrowserSurfaceSummary } from '@/lib/browser/types';

const browserProviders: BrowserProvider[] = [
  playwrightBrowserProvider,
  cdpBrowserProvider,
];

const browserProviderMap = new Map(browserProviders.map((provider) => [provider.id, provider]));

function sortSurfaces(left: BrowserSurfaceSummary, right: BrowserSurfaceSummary) {
  const statusRank = (status: BrowserSurfaceSummary['status']) => {
    switch (status) {
      case 'active':
        return 0;
      case 'idle':
        return 1;
      case 'unavailable':
      default:
        return 2;
    }
  };

  const statusDiff = statusRank(left.status) - statusRank(right.status);
  if (statusDiff !== 0) return statusDiff;

  const timeDiff = (right.lastActionAt ?? 0) - (left.lastActionAt ?? 0);
  if (timeDiff !== 0) return timeDiff;

  return left.id.localeCompare(right.id);
}

export async function getBrowserInventorySnapshot(): Promise<BrowserInventorySnapshot> {
  const discovered = await Promise.all(
    browserProviders.map(async (provider) => ({
      provider,
      surfaces: await provider.discoverSurfaces().catch(() => []),
    })),
  );

  const allSurfaces = discovered
    .flatMap(({ surfaces }) => surfaces)
    .sort(sortSurfaces);

  return {
    generatedAt: new Date().toISOString(),
    sourceLabel: discovered
      .filter(({ surfaces }) => surfaces.length > 0)
      .map(({ provider }) => provider.displayName)
      .join(' + ') || 'No browser providers discovered',
    surfaces: allSurfaces,
  };
}

export function getBrowserProvider(providerId: string) {
  return browserProviderMap.get(providerId);
}
