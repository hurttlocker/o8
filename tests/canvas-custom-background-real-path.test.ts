import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import esbuild from 'esbuild';
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveBrowserPath } from '../scripts/bench/measure-browser-boot.mjs';

const executablePath = resolveBrowserPath();
let browser: Browser;
let html: string;

async function open(page: Page, full = true) {
  await page.route('http://canvas.test/**', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto(`http://canvas.test/?full=${full}`);
  await page.getByText('Appearance', { exact: true }).waitFor();
}

async function image(page: Page, color = '#ffffff') {
  const data = await page.evaluate(color => {
    const canvas = document.createElement('canvas'); canvas.width = 100; canvas.height = 100;
    const context = canvas.getContext('2d')!;
    context.fillStyle = color; context.fillRect(0, 0, 100, 100);
    context.fillStyle = '#777777'; context.fillRect(25, 25, 50, 50);
    return canvas.toDataURL('image/png').split(',')[1];
  }, color);
  return { name: 'sample.png', mimeType: 'image/png', buffer: Buffer.from(data, 'base64') };
}

const background = (page: Page) => page.locator('[data-custom-canvas-background] canvas');
async function upload(page: Page, color?: string) {
  await page.getByLabel('Choose custom canvas image').setInputFiles(await image(page, color));
  await background(page).waitFor();
  await expect.poll(() => page.locator('[data-custom-canvas-background]').getAttribute('data-mode')).not.toBeNull();
  await expect.poll(() => page.getByRole('status').textContent()).toContain('Saved on this device');
}

async function removeImage(page: Page) {
  await page.getByRole('button', { name: 'Remove image', exact: true }).click();
  await page.getByRole('button', { name: 'Remove background image', exact: true }).click();
}

describe.skipIf(!executablePath)('custom canvas backgrounds through the appearance tuner', () => {
  beforeAll(async () => {
    const result = await esbuild.build({
      stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
        import React, { useState } from 'react';
        import { createRoot } from 'react-dom/client';
        import { TunerPanel } from './src/app/preview/canvas-glass/tuner';
        import { CanvasBackdropLayer } from './src/app/preview/canvas-glass/backdrops';
        import { glass } from './src/app/preview/canvas-glass/ui';
        import { applyCanvasGlassSettings, readCanvasGlassSettings, writeCanvasGlassSettings } from './src/lib/canvas-mode/glass-settings';
        function App() {
          const [settings, set] = useState(readCanvasGlassSettings);
          applyCanvasGlassSettings(settings);
          const change = patch => set(previous => writeCanvasGlassSettings({ ...previous, ...patch }));
          return <>
            <CanvasBackdropLayer kind={settings.backdrop} tone={settings.tone} customBackground={settings.customBackground} />
            <TunerPanel settings={settings} onChange={change} inTauri={false} personalDefault={null}
              loupeSize={100} loupeSizeRange={{min:80,max:200,step:1}} onLoupeSizeChange={()=>{}} onSaveDefault={()=>{}}
              full={new URLSearchParams(location.search).get('full') !== 'false'} />
            <article style={{...glass(true),position:'absolute',top:100,left:32,zIndex:3,width:220,padding:20}}>
              <p data-contrast-text style={{color:'var(--cnv-ink)',fontSize:14}}>Canvas conversation</p>
              <p style={{color:'var(--cnv-ink-muted)',fontSize:12}}>Local image. Your work stays readable.</p>
            </article>
          </>;
        }
        createRoot(document.getElementById('root')).render(<App />);
      ` },
      bundle: true, write: false, platform: 'browser', jsx: 'automatic',
      alias: { '@': path.resolve('src') }, define: { 'process.env.NODE_ENV': '"production"' },
    });
    html = `<style>body{margin:0;font-family:system-ui;background:#808080}#root{position:relative;height:100vh}</style><div id="root"></div><script>${result.outputFiles[0].text.replaceAll('</script', '<\\/script')}</script>`;
    browser = await chromium.launch({ executablePath: executablePath!, headless: true });
  });
  afterAll(async () => { await browser?.close(); });

  it('offers custom images with the built-ins even when extra controls are unavailable', async () => {
    const page = await browser.newPage();
    try {
      await open(page, false);
      expect(await page.getByRole('button', { name: 'Custom image', exact: true }).count()).toBe(1);
      expect(await page.getByRole('button', { name: 'Dots', exact: true }).count()).toBe(1);
    } finally { await page.context().close(); }
  });

  it('persists the image across reopening and restores the prior built-in on removal without network traffic', async () => {
    let context = await browser.newContext();
    let page = await context.newPage();
    try {
      await open(page);
      expect(await page.getByLabel('Choose custom canvas image').count()).toBe(1);
      await page.getByRole('button', { name: 'Dots', exact: true }).click();
      const traffic: string[] = [];
      page.on('request', request => traffic.push(request.url()));
      await upload(page);
      expect(traffic).toEqual([]);
      const state = await context.storageState();
      await context.close();
      context = await browser.newContext({ storageState: state }); page = await context.newPage();
      await open(page); await background(page).waitFor();
      await removeImage(page);
      expect(await background(page).count()).toBe(0);
      expect(await page.getByRole('button', { name: 'Dots', exact: true }).getAttribute('aria-pressed')).toBe('true');
      await page.reload();
      expect(await page.getByRole('button', { name: 'Dots', exact: true }).getAttribute('aria-pressed')).toBe('true');
      expect(await background(page).count()).toBe(0);
    } finally { await context.close(); }
  });

  it('renders photo, ASCII and dither modes from the same persisted image', async () => {
    const page = await browser.newPage();
    try {
      await open(page); expect(await page.getByLabel('Choose custom canvas image').count()).toBe(1);
      await upload(page);
      const outputs: string[] = [];
      for (const mode of ['Photo', 'ASCII', 'Dither']) {
        await page.getByRole('button', { name: mode, exact: true }).click();
        await expect.poll(() => page.locator('[data-custom-canvas-background]').getAttribute('data-mode')).toBe(mode.toLowerCase());
        outputs.push(await background(page).evaluate(canvas => (canvas as HTMLCanvasElement).toDataURL()));
      }
      expect(new Set(outputs).size).toBe(3);
      await page.reload();
      await expect.poll(() => page.locator('[data-custom-canvas-background]').getAttribute('data-mode')).toBe('dither');
    } finally { await page.context().close(); }
  });

  it('retains the image while switching built-ins and restores the most recent built-in', async () => {
    const page = await browser.newPage();
    try {
      await open(page); await upload(page);
      await page.getByRole('button', { name: 'Paper', exact: true }).click();
      expect(await background(page).count()).toBe(0);
      await page.getByRole('button', { name: 'Custom image', exact: true }).click();
      await background(page).waitFor();
      await page.getByRole('button', { name: 'Remove image', exact: true }).click();
      expect(await background(page).count()).toBe(1);
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      expect(await background(page).count()).toBe(1);
      await removeImage(page);
      expect(await page.getByRole('button', { name: 'Paper', exact: true }).getAttribute('aria-pressed')).toBe('true');
    } finally { await page.context().close(); }
  });

  it('keeps the saved image when import validation or persistent storage fails', async () => {
    const page = await browser.newPage();
    try {
      await open(page); expect(await page.getByLabel('Choose custom canvas image').count()).toBe(1);
      await upload(page);
      const original = await page.evaluate(() => localStorage.getItem('o8:canvas-glass'));
      await page.getByLabel('Choose custom canvas image').setInputFiles({ name: 'unsafe.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg/>') });
      await expect.poll(() => page.getByRole('alert').textContent()).toContain('PNG, JPEG or WebP');
      await page.getByLabel('Choose custom canvas image').setInputFiles({ name: 'large.png', mimeType: 'image/png', buffer: Buffer.alloc(5 * 1024 * 1024 + 1) });
      await expect.poll(() => page.getByRole('alert').textContent()).toContain('smaller than 5 MB');
      await page.getByLabel('Choose custom canvas image').setInputFiles({ name: 'broken.png', mimeType: 'image/png', buffer: Buffer.from('not an image') });
      await expect.poll(() => page.getByRole('alert').textContent()).toContain('could not be read');
      await page.evaluate(() => { Storage.prototype.setItem = () => { throw new DOMException('full', 'QuotaExceededError'); }; });
      await page.getByLabel('Choose custom canvas image').setInputFiles(await image(page, '#000000'));
      await expect.poll(() => page.getByRole('alert').textContent()).toContain('could not be saved');
      expect(await page.evaluate(() => localStorage.getItem('o8:canvas-glass'))).toBe(original);
      expect(await background(page).count()).toBe(1);
      await removeImage(page);
      await expect.poll(() => page.getByRole('alert').textContent()).toContain('could not be saved');
      expect(await background(page).count()).toBe(1);
      expect(await page.evaluate(() => localStorage.getItem('o8:canvas-glass'))).toBe(original);
    } finally { await page.context().close(); }
  });

  it('rejects a remote image URL from persisted settings before rendering or requesting it', async () => {
    const page = await browser.newPage();
    try {
      await open(page);
      const traffic: string[] = [];
      page.on('request', request => traffic.push(request.url()));
      await page.evaluate(() => localStorage.setItem('o8:canvas-glass', JSON.stringify({
        backdrop: 'custom', customBackground: { dataUrl: 'https://remote.invalid/photo.jpg', mode: 'photo', previousBackdrop: 'dots' },
      })));
      await page.reload();
      await page.getByText('Appearance', { exact: true }).waitFor();
      expect(await background(page).count()).toBe(0);
      expect(traffic.filter(url => !url.startsWith('http://canvas.test/'))).toEqual([]);
    } finally { await page.context().close(); }
  });

  for (const tone of ['light', 'dark']) for (const sample of ['bright', 'dark']) {
    it(`keeps readable ${tone} text over the ${sample} image`, async () => {
      const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
      try {
        await open(page); expect(await page.getByLabel('Choose custom canvas image').count()).toBe(1);
        await page.getByRole('button', { name: tone === 'light' ? 'Light' : 'Dark', exact: true }).click();
        await upload(page, sample === 'bright' ? '#ffffff' : '#000000');
        // Composite the actual rendered ink over the worst image pixel and scrim.
        const ratio = await page.locator('[data-contrast-text]').evaluate((text, sample) => {
          const ink = getComputedStyle(text).color.match(/[\d.]+/g)!.map(Number);
          const scrim = getComputedStyle(document.querySelector('[data-custom-canvas-scrim]')!).backgroundColor.match(/[\d.]+/g)!.map(Number);
          const bg = scrim.slice(0, 3).map(c => c * scrim[3] + (sample === 'bright' ? 255 : 0) * (1 - scrim[3]));
          const fg = ink.slice(0, 3).map((c, i) => c * (ink[3] ?? 1) + bg[i] * (1 - (ink[3] ?? 1)));
          const lum = (rgb: number[]) => rgb.map(c => c / 255).map(c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4).reduce((n, c, i) => n + c * [.2126, .7152, .0722][i], 0);
          return (Math.max(lum(fg), lum(bg)) + .05) / (Math.min(lum(fg), lum(bg)) + .05);
        }, sample);
        expect(ratio).toBeGreaterThanOrEqual(4.5);
        const directory = 'docs/evidence/2865';
        if (process.env.O8_CAPTURE_BACKGROUND_EVIDENCE === '1') {
          await mkdir(directory, { recursive: true });
          await page.screenshot({ path: `${directory}/${tone}-${sample}.png` });
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await page.setViewportSize({ width: 1680, height: 1050 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      } finally { await page.context().close(); }
    });
  }
});
