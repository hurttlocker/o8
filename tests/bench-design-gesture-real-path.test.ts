import { chromium } from 'playwright-core';
import { describe, expect, it } from 'vitest';
import { resolveBrowserPath } from '../scripts/bench/measure-browser-boot.mjs';
// @ts-expect-error -- evaluated browser observers are intentionally plain JavaScript.
import { observePaintedCondition } from '../scripts/bench/interactions/page-instrumentation.mjs';

const executablePath = resolveBrowserPath();

type Observation = {
  durationMs: number | null;
  triggerAt: number | null;
  observerStartedAt: number;
  paintedAt: number | null;
  triggerTrusted: boolean | null;
  note: string | null;
};

describe.skipIf(!executablePath)('Design Mode benchmark gesture boundary', () => {
  it.each([0, 500])('starts at trusted release and retains %s ms of result delay', async (delayMs) => {
    const browser = await chromium.launch({ executablePath: executablePath!, headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent('<div id="surface" style="width:400px;height:300px"></div>');
      await page.evaluate((delay) => {
        document.querySelector('#surface')!.addEventListener('pointerup', () => {
          setTimeout(() => {
            const prompt = document.createElement('textarea');
            prompt.id = 'prompt';
            document.body.appendChild(prompt);
            prompt.focus();
          }, delay);
        });
      }, delayMs);
      const pending = page.evaluate(observePaintedCondition, {
        selector: '#prompt', timeoutMs: 5000, requireFocusInside: true,
        triggerEvent: 'pointerup', triggerSelector: '#surface',
      });
      await page.evaluate(() => true);
      await page.mouse.move(50, 50);
      await page.mouse.down();
      await page.waitForTimeout(250);
      await page.mouse.move(100, 100);
      await page.mouse.up();
      const result = await pending as Observation;
      expect(result.triggerAt).not.toBeNull();
      expect(result.paintedAt).not.toBeNull();
      expect(result.triggerAt! - result.observerStartedAt).toBeGreaterThanOrEqual(200);
      expect(result.triggerTrusted).toBe(true);
      expect(result.durationMs).toBeCloseTo(result.paintedAt! - result.triggerAt!, 1);
      if (delayMs > 0) expect(result.durationMs).toBeGreaterThanOrEqual(delayMs - 1);
    } finally {
      await browser.close();
    }
  }, 15_000);

  it('does not accept an existing result or a release outside the measured surface', async () => {
    const browser = await chromium.launch({ executablePath: executablePath!, headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent('<div id="surface"></div><textarea id="prompt"></textarea>');
      const pending = page.evaluate(observePaintedCondition, {
        selector: '#prompt', timeoutMs: 300, requireFocusInside: false,
        triggerEvent: 'pointerup', triggerSelector: '#surface',
      });
      await page.evaluate(() => true);
      await page.mouse.click(600, 500);
      const result = await pending as Observation;
      expect(result.durationMs).toBeNull();
      expect(result.note).toContain('pointerup');
    } finally {
      await browser.close();
    }
  }, 15_000);
});
