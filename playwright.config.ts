import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  retries: 0,
  use: {
    baseURL: 'http://localhost:3001',
    headless: true,
    viewport: { width: 1440, height: 900 },
    actionTimeout: 10_000,
  },
  projects: [
    {
      name: 'desktop-shell',
      use: { browserName: 'chromium' },
    },
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:3001',
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
