import { test } from '@playwright/test';

test('diagnostic: click split button and trace', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.removeItem('cortex-ide:dashboard-tiles:v1');
  });
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-tile-active="true"]', { timeout: 20_000 });

  // Instrument the split button to trace clicks
  await page.evaluate(() => {
    const btn = document.querySelector('[data-testid="workspace-split-vertical"]') as HTMLElement;
    if (btn) {
      btn.addEventListener('click', () => {
        (window as unknown as Record<string, unknown>).__splitClicked = true;
        console.log('SPLIT CLICKED');
      }, { capture: true });
    }
  });

  const splitBtn = page.locator('[data-testid="workspace-split-vertical"]').first();

  // Check button is not disabled
  const isDisabled = await splitBtn.isDisabled();
  console.log('Button disabled:', isDisabled);

  // Check button is visible and in viewport
  const isVisible = await splitBtn.isVisible();
  console.log('Button visible:', isVisible);

  // Check for overlapping elements
  const overlap = await page.evaluate(() => {
    const btn = document.querySelector('[data-testid="workspace-split-vertical"]') as HTMLElement;
    if (!btn) return { found: false };
    const rect = btn.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const topEl = document.elementFromPoint(centerX, centerY);
    return {
      found: true,
      btnTag: btn.tagName,
      topElTag: topEl?.tagName,
      topElTestId: topEl?.getAttribute('data-testid'),
      topElClass: topEl?.className,
      topElIsBtn: topEl === btn,
      topElIsChild: btn.contains(topEl),
      centerX,
      centerY,
    };
  });
  console.log('Overlap check:', JSON.stringify(overlap));

  // Try Playwright click
  await splitBtn.click({ force: true });

  // Wait a bit
  await page.waitForTimeout(2_000);

  // Check if click was received
  const clicked = await page.evaluate(() => (window as unknown as Record<string, unknown>).__splitClicked);
  console.log('Click received by JS listener:', clicked);

  // Check tile count
  const tileCount = await page.locator('[data-tile-id]').count();
  console.log('Tile count after click:', tileCount);

  // Screenshot after click
  await page.screenshot({ path: '/tmp/cortex-diag-after-click.png', fullPage: true });

  // If still 1, try dispatching click event directly
  if (tileCount === 1) {
    console.log('Direct click failed, trying dispatchEvent...');
    await page.evaluate(() => {
      const btn = document.querySelector('[data-testid="workspace-split-vertical"]') as HTMLElement;
      if (btn) {
        btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      }
    });
    await page.waitForTimeout(2_000);
    const tileCount2 = await page.locator('[data-tile-id]').count();
    console.log('Tile count after dispatchEvent:', tileCount2);
  }
});
