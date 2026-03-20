import { createHttpBrowserProvider } from '@/lib/browser/http-provider';

export const playwrightBrowserProvider = createHttpBrowserProvider({
  id: 'playwright',
  displayName: 'Playwright discovery',
  discoveryUrlEnv: 'CORTEX_BROWSER_PLAYWRIGHT_DISCOVERY_URL',
});
