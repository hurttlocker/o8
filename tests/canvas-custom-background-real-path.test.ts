import path from 'node:path';
import os from 'node:os';
import { mkdir, writeFile } from 'node:fs/promises';
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

async function image(page: Page, sample: 'bright' | 'dark' = 'bright') {
  const data = await page.evaluate(sample => {
    const canvas = document.createElement('canvas'); canvas.width = 1440; canvas.height = 900;
    const context = canvas.getContext('2d')!;
    let seed = 2865;
    const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    const sky = context.createLinearGradient(0, 0, 1100, 900);
    const colors = sample === 'bright'
      ? ['#f8ddbd', '#f2a39d', '#a2b8d0', '#44a8a3']
      : ['#11192d', '#39445c', '#8b687a', '#173c48'];
    colors.forEach((color, index) => sky.addColorStop(index / 3, color));
    context.fillStyle = sky; context.fillRect(0, 0, 1440, 900);
    const glow = context.createRadialGradient(460, 270, 0, 460, 270, 720);
    glow.addColorStop(0, sample === 'bright' ? '#fff5cdbb' : '#d6a89666');
    glow.addColorStop(1, '#ffffff00');
    context.fillStyle = glow; context.fillRect(0, 0, 1440, 900);
    // Layered, misty ridgelines give the darker gradient a photographic depth.
    if (sample === 'dark') for (let ridge = 0; ridge < 5; ridge++) {
      context.beginPath(); context.moveTo(0, 900);
      for (let x = 0; x <= 1480; x += 40) {
        context.lineTo(x, 400 + ridge * 95 + Math.sin(x / 210 + ridge) * 65 + random() * 20);
      }
      context.lineTo(1440, 900); context.closePath();
      context.fillStyle = ['#58617366', '#3a536a88', '#29485bcc', '#193b4fee', '#102b39'][ridge];
      context.fill();
    }
    // Seeded translucent brush strokes and fine grain, with no downloaded assets.
    for (let stroke = 0; stroke < 3200; stroke++) {
      const x = random() * 1440, y = random() * 900;
      context.beginPath(); context.ellipse(x, y, 12 + random() * 90, 2 + random() * 18, -.4, 0, Math.PI * 2);
      context.fillStyle = colors[Math.floor(random() * colors.length)];
      context.globalAlpha = sample === 'bright' ? .035 : .015; context.fill();
    }
    for (let grain = 0; grain < 50000; grain++) {
      context.globalAlpha = random() * .035;
      context.fillStyle = grain % 2 ? '#ffffff' : '#000000';
      context.fillRect(random() * 1440, random() * 900, 1, 1);
    }
    return canvas.toDataURL('image/png').split(',')[1];
  }, sample);
  return { name: `${sample === 'bright' ? 'Painterly coast' : 'Mountain dusk'}.png`, mimeType: 'image/png', buffer: Buffer.from(data, 'base64') };
}

const background = (page: Page) => page.locator('[data-custom-canvas-background] canvas');
async function upload(page: Page, sample?: 'bright' | 'dark') {
  await page.getByLabel('Choose custom canvas image').setInputFiles(await image(page, sample));
  await background(page).waitFor();
  await expect.poll(() => page.locator('[data-custom-canvas-background]').getAttribute('data-mode')).not.toBeNull();
  await expect.poll(() => page.getByRole('status').textContent()).toContain('Saved on this device');
}

async function panelContrast(page: Page) {
  return page.evaluate(() => {
    const rgba = (value: string) => value.match(/[\d.]+/g)!.map(Number);
    const over = (paint: number[], base: number[]) => paint.slice(0, 3).map((c, i) => c * (paint[3] ?? 1) + base[i] * (1 - (paint[3] ?? 1)));
    const lum = (rgb: number[]) => rgb.map(c => c / 255).map(c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4).reduce((n, c, i) => n + c * [.2126, .7152, .0722][i], 0);
    const scrim = rgba(getComputedStyle(document.querySelector('[data-custom-canvas-scrim]')!).backgroundColor);
    const canvas = document.querySelector('[data-custom-canvas-background] canvas') as HTMLCanvasElement;
    const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
    // Actual image pixels plus black/white bounds also cover blur and saturation.
    const samples = [[0, 0, 0], [255, 255, 255]];
    for (let i = 0; i < pixels.length; i += 400) samples.push(Array.from(pixels.slice(i, i + 3)));
    const heading = Array.from(document.querySelectorAll('span')).find(span => span.textContent === 'Appearance')!;
    const pickerLabel = document.querySelector('section[aria-label="Canvas background"] > span')!;
    return [...document.querySelectorAll('[data-contrast-text]'), heading, pickerLabel].map(text => {
      const panel = text.closest('[data-contrast-surface]') ?? heading.parentElement!;
      const surface = rgba(getComputedStyle(panel).backgroundColor);
      const ink = rgba(getComputedStyle(text).color);
      const ratio = Math.min(...samples.map(pixel => {
        const bg = over(surface, over(scrim, pixel));
        const fg = over(ink, bg);
        return (Math.max(lum(fg), lum(bg)) + .05) / (Math.min(lum(fg), lum(bg)) + .05);
      }));
      return { label: text.getAttribute('data-contrast-text') ?? `tuner-${text.textContent}`, ratio, blur: getComputedStyle(panel).backdropFilter };
    });
  });
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
        import { glass, glassChat } from './src/app/preview/canvas-glass/ui';
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
            <article data-contrast-surface style={{...glass(),position:'absolute',top:140,left:32,zIndex:3,width:'min(390px, 38vw)',padding:24,borderRadius:18}}>
              <p data-contrast-text="card-primary" style={{fontSize:18,fontWeight:400,marginTop:0}}>A little room to think</p>
              <p data-contrast-text="card-secondary" style={{color:'var(--cnv-ink-muted)',fontSize:13,lineHeight:1.65}}>Keep your ideas, notes and conversations together. A quieter workspace, with a view that feels like yours.</p>
              <p style={{fontSize:12,lineHeight:1.65}}>Review the next draft<br/>Sketch a new direction<br/>Leave space for something unexpected</p>
            </article>
            <article data-contrast-surface style={{...glassChat(),position:'absolute',top:460,left:32,zIndex:3,width:'min(320px, 34vw)',padding:24,borderRadius:18}}>
              <p data-contrast-text="chat-primary" style={{fontSize:14,marginTop:0}}>Canvas conversation</p>
              <p data-contrast-text="chat-secondary" style={{color:'var(--cnv-chat-ink-muted)',fontSize:13,lineHeight:1.65,marginBottom:0}}>The latest draft is ready. Pick up where you left off, whenever you are ready.</p>
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
      await page.getByLabel('Choose custom canvas image').setInputFiles(await image(page, 'dark'));
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

  for (const tone of ['light', 'dark'] as const) for (const sample of ['bright', 'dark'] as const) {
    it(`keeps readable ${tone} text over the ${sample} image`, async () => {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      try {
        await open(page); expect(await page.getByLabel('Choose custom canvas image').count()).toBe(1);
        await page.getByRole('button', { name: tone === 'light' ? 'Light' : 'Dark', exact: true }).click();
        await upload(page, sample);
        const contrasts = await panelContrast(page);
        for (const { ratio, blur } of contrasts) {
          expect(ratio).toBeGreaterThanOrEqual(4.5);
          expect(blur).toContain('blur(');
        }
        const wash = await page.locator('[data-custom-canvas-scrim]').evaluate(scrim => Number(getComputedStyle(scrim).backgroundColor.match(/[\d.]+/g)![3]));
        expect(wash).toBeLessThanOrEqual(.25);
        const directory = path.join(os.homedir(), 'o8-shots-2865');
        if (process.env.O8_CAPTURE_BACKGROUND_EVIDENCE === '1') {
          await mkdir(directory, { recursive: true });
          await page.screenshot({ path: `${directory}/${tone}-${sample}.png` });
          await writeFile(path.join(directory, `${tone}-${sample}.json`), JSON.stringify(contrasts, null, 2));
        }
        await page.setViewportSize({ width: 900, height: 700 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await page.setViewportSize({ width: 1680, height: 1050 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        // Persisted clear/low-ink tuning must not erase the image's reading surfaces.
        await page.evaluate(() => {
          const saved = JSON.parse(localStorage.getItem('o8:canvas-glass')!);
          localStorage.setItem('o8:canvas-glass', JSON.stringify({ ...saved, frost: 0, chatFrost: 0, tint: 0, chatTint: 0, ink: .55,
            chatTone: saved.tone === 'light' ? 'dark' : 'light' }));
        });
        await page.reload(); await background(page).waitFor();
        for (const { ratio, blur } of await panelContrast(page)) {
          expect(ratio).toBeGreaterThanOrEqual(4.5);
          expect(blur).not.toContain('blur(0px)');
        }
        await removeImage(page);
        const restored = await page.evaluate(() => ({
          tint: getComputedStyle(document.documentElement).getPropertyValue('--cnv-tint'),
          frost: getComputedStyle(document.documentElement).getPropertyValue('--cnv-frost'),
          saved: JSON.parse(localStorage.getItem('o8:canvas-glass')!),
        }));
        expect(restored.tint).toContain('0.00)');
        expect(restored.frost).toBe('0px');
        expect(restored.saved).toMatchObject({ frost: 0, tint: 0, ink: .55 });
      } finally { await page.context().close(); }
    });
  }
});
