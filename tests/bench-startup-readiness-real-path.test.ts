import { chromium, type Page } from 'playwright-core';
import { describe, expect, it } from 'vitest';
import { resolveBrowserPath } from '../scripts/bench/measure-browser-boot.mjs';
// @ts-expect-error -- serialized browser probes intentionally use plain JavaScript.
import { installStartupReadinessProbe, readStartupReadinessSample } from '../scripts/bench/interactions/startup-readiness.mjs';
import { evaluateInteractionBudgets } from '../scripts/bench/interactions/budgets.mjs';
import { scenarioResult } from '../scripts/bench/interactions/statistics.mjs';

const executablePath = resolveBrowserPath();
type Sample = { durationMs: number | null; readinessMs?: number; inputPaintMs?: number;
  excludedDriverWaitMs?: number; hydrationToPaintWallMs?: number; inputTrusted?: boolean; note?: string };

async function fixture(page: Page, readyDelay: number) {
  await page.setContent('<textarea data-o8-active-composer="true" disabled></textarea>');
  await page.evaluate((delay) => {
    (globalThis as typeof globalThis & { __o8Interactions: { hydratedAtMs: number } }).__o8Interactions = { hydratedAtMs: performance.now() };
    setTimeout(() => { document.querySelector('textarea')!.disabled = false; }, delay);
  }, readyDelay);
  await page.evaluate(installStartupReadinessProbe, { timeoutMs: 8000 });
}

async function typeAndRead(page: Page): Promise<Sample> {
  await page.locator('textarea').focus();
  await page.keyboard.press('o');
  await page.waitForFunction(() => (globalThis as typeof globalThis & {
    __o8StartupReadiness?: { result: unknown };
  }).__o8StartupReadiness?.result !== null);
  return page.evaluate(readStartupReadinessSample);
}

describe.skipIf(!executablePath)('startup readiness through real trusted browser input', () => {
  it('excludes delayed driver delivery while retaining readiness and accepted input paint', async () => {
    const browser = await chromium.launch({ executablePath: executablePath!, headless: true });
    try {
      const page = await browser.newPage();
      await fixture(page, 150);
      await page.waitForFunction(() => !document.querySelector('textarea')!.disabled);
      await page.waitForTimeout(650);
      const sample = await typeAndRead(page);
      expect(sample.inputTrusted).toBe(true);
      expect(sample.readinessMs!).toBeGreaterThanOrEqual(140);
      expect(sample.inputPaintMs!).toBeGreaterThan(0);
      expect(sample.excludedDriverWaitMs!).toBeGreaterThanOrEqual(550);
      expect(sample.durationMs!).toBeCloseTo(sample.readinessMs! + sample.inputPaintMs!, 1);
      expect(sample.hydrationToPaintWallMs! - sample.durationMs!).toBeCloseTo(sample.excludedDriverWaitMs!, 1);
      expect(await page.locator('textarea').inputValue()).toBe('o');
    } finally { await browser.close(); }
  }, 20_000);

  it('still fails the unchanged startup budget when the app delays enabling the composer', async () => {
    const browser = await chromium.launch({ executablePath: executablePath!, headless: true });
    try {
      const page = await browser.newPage();
      await fixture(page, 2150);
      await page.waitForFunction(() => !document.querySelector('textarea')!.disabled);
      await page.waitForTimeout(80);
      const sample = await typeAndRead(page);
      expect(sample.durationMs!).toBeGreaterThan(2000);
      const result = evaluateInteractionBudgets({ target: { buildMode: 'production' }, scenarios: {
        first_interaction_accepted_ms: scenarioResult({ samples: [{ durationMs: sample.durationMs }] }),
      } });
      expect(result.failed).toContain('first_interaction_accepted_ms');
    } finally { await browser.close(); }
  }, 20_000);

  it('does not turn synthetic input or a replaced input target into a startup pass', async () => {
    const browser = await chromium.launch({ executablePath: executablePath!, headless: true });
    try {
      const page = await browser.newPage();
      await fixture(page, 0);
      await page.evaluate(() => {
        const input = document.querySelector('textarea')!;
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true }));
        input.value = 'x';
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      expect((await page.evaluate(readStartupReadinessSample) as Sample).durationMs).toBeNull();
      await page.waitForTimeout(80);
      await page.evaluate(() => document.querySelector('textarea')!.addEventListener('input', event => {
        (event.target as HTMLTextAreaElement).remove();
      }, { once: true }));
      const sample = await typeAndRead(page);
      expect(sample.durationMs).toBeNull();
      expect(sample.note).toContain('through paint');
    } finally { await browser.close(); }
  }, 20_000);
});
