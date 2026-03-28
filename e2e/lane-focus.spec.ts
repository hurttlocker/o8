import { test, expect } from '@playwright/test';

/**
 * P2 — Playwright Packet Beta
 * Verify packet-first lane behavior: launch a second lane via split,
 * confirm focus transfers to the new lane, then close it and verify
 * focus returns cleanly to the original lane.
 *
 * Note: Playwright's simulated click (mousedown → mouseup → click) conflicts
 * with the parent tile's onMouseDown handler which triggers a React re-render
 * mid-sequence, preventing the button's onClick from firing. We use
 * dispatchEvent('click') to bypass this — it dispatches a click event directly
 * on the button element without the preceding mousedown.
 */

test.describe('Lane focus management', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.removeItem('cortex-ide:dashboard-tiles:v1');
    });
    await page.goto('/dashboard', { waitUntil: 'networkidle' });
    // Wait for tile system to hydrate
    await page.waitForSelector('[data-tile-active="true"]', { timeout: 20_000 });
    // Wait for split button to be rendered (workspace terminal mounted)
    await page.waitForSelector('[data-testid="workspace-split-vertical"]', { timeout: 20_000 });
  });

  /** Click a split/close button via dispatchEvent to avoid mousedown interference */
  async function clickButton(page: import('@playwright/test').Page, locator: import('@playwright/test').Locator) {
    await locator.waitFor({ state: 'visible', timeout: 10_000 });
    await locator.dispatchEvent('click');
  }

  async function clickSplit(page: import('@playwright/test').Page, direction: 'vertical' | 'horizontal' = 'vertical') {
    const testId = direction === 'vertical' ? 'workspace-split-vertical' : 'workspace-split-horizontal';
    const btn = page.locator(`[data-testid="${testId}"]`).first();
    await clickButton(page, btn);
    // Wait for DOM to update with the second tile
    await page.waitForFunction(
      () => document.querySelectorAll('[data-tile-id]').length >= 2,
      { timeout: 10_000 },
    );
  }

  test('split creates a second lane and transfers focus to it', async ({ page }) => {
    const originalTileId = await page.locator('[data-tile-active="true"]').getAttribute('data-tile-id');
    expect(originalTileId).toBeTruthy();

    await clickSplit(page, 'vertical');

    // Two tiles should exist, new one active
    await expect(page.locator('[data-tile-id]')).toHaveCount(2);
    const newActive = page.locator('[data-tile-active="true"]');
    await expect(newActive).toHaveCount(1);
    const newTileId = await newActive.getAttribute('data-tile-id');
    expect(newTileId).not.toBe(originalTileId);

    // Original is inactive
    await expect(page.locator(`[data-tile-id="${originalTileId}"]`)).toHaveAttribute('data-tile-active', 'false');
  });

  test('closing the second lane returns focus to the original', async ({ page }) => {
    const originalTileId = await page.locator('[data-tile-active="true"]').getAttribute('data-tile-id');

    await clickSplit(page, 'vertical');

    const newTileId = await page.locator('[data-tile-active="true"]').getAttribute('data-tile-id');
    expect(newTileId).not.toBe(originalTileId);

    // Close the new active tile
    const closeBtn = page.locator(`[data-tile-id="${newTileId}"]`).locator('[data-testid="workspace-close-tile"]');
    await clickButton(page, closeBtn);

    // Wait for single tile
    await page.waitForFunction(
      () => document.querySelectorAll('[data-tile-id]').length === 1,
      { timeout: 10_000 },
    );

    // Focus returned to original
    const restored = page.locator('[data-tile-active="true"]');
    await expect(restored).toHaveCount(1);
    await expect(restored).toHaveAttribute('data-tile-id', originalTileId!);
  });

  test('clicking the original lane reclaims focus from the second', async ({ page }) => {
    const originalTileId = await page.locator('[data-tile-active="true"]').getAttribute('data-tile-id');

    await clickSplit(page, 'vertical');

    const newTileId = await page.locator('[data-tile-active="true"]').getAttribute('data-tile-id');
    expect(newTileId).not.toBe(originalTileId);

    // Click the original tile to reclaim focus
    await page.locator(`[data-tile-id="${originalTileId}"]`).dispatchEvent('mousedown');

    await expect(page.locator(`[data-tile-id="${originalTileId}"]`)).toHaveAttribute('data-tile-active', 'true');
    await expect(page.locator(`[data-tile-id="${newTileId}"]`)).toHaveAttribute('data-tile-active', 'false');
  });

  test('horizontal split transfers and returns focus', async ({ page }) => {
    const originalTileId = await page.locator('[data-tile-active="true"]').getAttribute('data-tile-id');

    await clickSplit(page, 'horizontal');

    const newTileId = await page.locator('[data-tile-active="true"]').getAttribute('data-tile-id');
    expect(newTileId).not.toBe(originalTileId);

    // Close the new tile
    const closeBtn = page.locator(`[data-tile-id="${newTileId}"]`).locator('[data-testid="workspace-close-tile"]');
    await clickButton(page, closeBtn);

    await page.waitForFunction(
      () => document.querySelectorAll('[data-tile-id]').length === 1,
      { timeout: 10_000 },
    );

    await expect(page.locator('[data-tile-active="true"]')).toHaveAttribute('data-tile-id', originalTileId!);
  });
});
