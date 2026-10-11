import 'server-only';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { Browser } from 'playwright-core';
import { defaultVisualizationTheme, visualizationSrcdoc } from './document';
import { VisualizationError } from './errors';

interface PreviewState { busy: boolean }
const globalState = globalThis as typeof globalThis & { __o8VisualizationPreview?: PreviewState };
const state = globalState.__o8VisualizationPreview ??= { busy: false };

export interface VisualizationPreview {
  image: string;
  mimeType: 'image/png';
  width: number;
  height: number;
  contentHeight: number;
  diagnostics: string[];
  layouts: Array<{ width: number; height: number; overflow: number }>;
}

/** Dedicated unauthenticated browser, no network or downloads, closed after every preview. */
export async function previewVisualization(html: string, input: { width?: unknown; appearance?: unknown }): Promise<VisualizationPreview> {
  const width = input.width === undefined ? 728 : input.width;
  if (typeof width !== 'number' || !Number.isInteger(width) || width < 320 || width > 1600) throw new VisualizationError('invalid_width', 'Preview width must be 320–1600 pixels.');
  if (input.appearance !== undefined && input.appearance !== 'light' && input.appearance !== 'dark') throw new VisualizationError('invalid_appearance', 'Appearance must be light or dark.');
  if (state.busy) throw new VisualizationError('preview_busy', 'Another preview is running. Retry shortly.', 429);
  state.busy = true;
  let browser: Browser | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const { chromium } = await import('playwright-core');
    try {
      const executablePath = process.platform === 'linux'
        ? ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(existsSync)
        : undefined;
      // Prefer an already-installed matching headless shell. No browser download
      // happens here; ordinary installations fall back to system Chrome.
      try { browser = await chromium.launch({ headless: true, timeout: 8_000 }); }
      catch { browser = await chromium.launch({ ...(executablePath ? { executablePath } : { channel: 'chrome' }), headless: true, timeout: 8_000 }); }
    } catch {
      throw new VisualizationError('preview_unavailable', 'Install Chrome or Chromium to enable screenshot previews. Saving and displaying visualizations still works.', 503);
    }
    const context = await browser.newContext({ viewport: { width, height: 800 }, serviceWorkers: 'block', acceptDownloads: false,
      colorScheme: input.appearance === 'light' ? 'light' : 'dark' });
    await context.route('**/*', route => route.abort());
    await context.routeWebSocket('**/*', socket => socket.close());
    const page = await context.newPage();
    page.setDefaultTimeout(8_000);
    const diagnostics: string[] = [];
    const note = (message: string) => { if (diagnostics.length < 20) diagnostics.push(message.slice(0, 500)); };
    page.on('console', message => { if (message.type() === 'error' || message.type() === 'warning') note(message.text()); });
    page.on('pageerror', error => note(error.message));
    const nonce = randomUUID();
    const work = async () => {
      // Opaque screenshots let agents judge light-theme contrast correctly;
      // the document itself remains transparent in the actual transcript.
      const background = input.appearance === 'light' ? '#f8fafc' : '#11151d';
      await page.setContent(`<html><body style="margin:0;background:${background}"><iframe id="visual" sandbox="allow-scripts" style="border:0;width:100%;height:800px"></iframe></body></html>`);
      await page.evaluate(({ doc, key }) => {
        const frame = document.querySelector<HTMLIFrameElement>('#visual')!;
        const preview = window as unknown as { visualHeight: number; visualLayout: { width: number; height: number; overflow: number } };
        preview.visualHeight = 0;
        addEventListener('message', event => {
          if (event.source !== frame.contentWindow || event.data?.nonce !== key || event.data.type !== 'o8-visualization:height') return;
          preview.visualHeight = Math.min(4000, Math.max(80, event.data.height));
          if (Number.isFinite(event.data.width) && Number.isFinite(event.data.overflow)) preview.visualLayout = {
            width: event.data.width, height: event.data.height, overflow: event.data.overflow,
          };
        });
        frame.srcdoc = doc;
      }, { doc: await visualizationSrcdoc(html, nonce, defaultVisualizationTheme(input.appearance === 'light' ? 'light' : 'dark')), key: nonce });
      await page.waitForFunction(() => (window as unknown as { visualHeight: number }).visualHeight > 0);
      const contentHeight = await page.evaluate(() => (window as unknown as { visualHeight: number }).visualHeight);
      const height = Math.min(4000, Math.ceil(contentHeight));
      await page.setViewportSize({ width, height });
      await page.locator('#visual').evaluate((frame, frameHeight) => { (frame as HTMLElement).style.height = `${frameHeight}px`; }, height);
      // Fonts, layout and chart paint settle without waiting for agent timers.
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      const bytes = await page.screenshot({ type: 'png', omitBackground: true, timeout: 8_000 });
      if (bytes.length > 4 * 1024 * 1024) throw new VisualizationError('preview_too_large', 'Preview image exceeds 4 MiB.', 413);
      const layouts: VisualizationPreview['layouts'] = [];
      for (const checkWidth of [...new Set([320, 480, width, 1024])].sort((a, b) => a - b)) {
        await page.setViewportSize({ width: checkWidth, height });
        await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        // Use the existing scoped bridge rather than browser-specific frame inspection.
        // Some Chrome versions expose opaque srcdoc frames as a separate CDP target.
        await page.waitForFunction(expected => (window as unknown as { visualLayout?: { width: number } }).visualLayout?.width === expected, checkWidth);
        const measured = await page.evaluate(() => (window as unknown as { visualLayout: { width: number; height: number; overflow: number } }).visualLayout);
        layouts.push(measured);
        if (measured.overflow > 1) note(`Horizontal overflow at ${checkWidth}px: ${measured.overflow}px. Reflow the chart, labels or controls.`);
      }
      return { image: bytes.toString('base64'), mimeType: 'image/png' as const, width, height, contentHeight, diagnostics, layouts };
    };
    return await Promise.race([work(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new VisualizationError('preview_timeout', 'Preview timed out. Simplify the page and try again.', 408)), 15_000);
    })]);
  } finally {
    if (timer) clearTimeout(timer);
    await browser?.close().catch(() => {});
    state.busy = false;
  }
}
