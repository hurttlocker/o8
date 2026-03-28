import { test, expect } from '@playwright/test';

test('diagnostic: inspect dashboard state', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.removeItem('cortex-ide:dashboard-tiles:v1');
  });
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });

  // Wait for page to settle
  await page.waitForTimeout(5_000);

  // Screenshot
  await page.screenshot({ path: '/tmp/cortex-diag.png', fullPage: true });

  // Dump all data-tile-* and data-testid elements
  const tileEls = await page.evaluate(() => {
    const tiles = document.querySelectorAll('[data-tile-id]');
    const testIds = document.querySelectorAll('[data-testid]');
    return {
      tileCount: tiles.length,
      tiles: Array.from(tiles).map(el => ({
        id: el.getAttribute('data-tile-id'),
        kind: el.getAttribute('data-tile-kind'),
        active: el.getAttribute('data-tile-active'),
        rect: (el as HTMLElement).getBoundingClientRect(),
      })),
      testIds: Array.from(testIds).map(el => ({
        testId: el.getAttribute('data-testid'),
        visible: (el as HTMLElement).offsetParent !== null,
        rect: (el as HTMLElement).getBoundingClientRect(),
      })),
      // Check if setup wizard is showing
      setupWizard: !!document.querySelector('[data-testid="setup-wizard"]'),
      // Body HTML length
      bodyLength: document.body.innerHTML.length,
      // Check for common overlays
      modals: document.querySelectorAll('[role="dialog"]').length,
    };
  });

  console.log('=== DIAGNOSTIC ===');
  console.log(JSON.stringify(tileEls, null, 2));

  expect(tileEls.tileCount).toBeGreaterThan(0);
});
