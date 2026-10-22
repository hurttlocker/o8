// Uses the same esbuild + Chromium layout harness as agent-tile-header-layout-real-path.
// No app server or live data: the row, review control, shelf and global button CSS are real.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveBrowserPath } from '../scripts/bench/measure-browser-boot.mjs';
import { getPalette, resolveTheme } from '../src/lib/theme/registry';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const executablePath = resolveBrowserPath();
const labels = ['Pinned', 'Recents', 'Today', 'Yesterday', 'Previous 7 days'];
const fixture = `
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { ExtraAgentRowView } from '@/components/desktop/AgentPanelExtraAgentRow';
import { ChatHistoryShelf } from '@/components/desktop/repo-focus/tabs/chats/ChatHistoryShelf';
import { WorkerReviewAction } from '@/components/desktop/workspace-terminal/WorkerReviewAction';
let root;
window.mountSidebar = (width, labels) => {
  root?.unmount();
  document.body.replaceChildren();
  const host = document.createElement('main');
  host.style.width = width + 'px';
  document.body.append(host);
  window.opened = 0;
  window.selected = 0;
  root = createRoot(host);
  root.render(createElement('div', null,
    ...labels.map((label, index) => createElement(ChatHistoryShelf, { key: label, label },
      createElement(ExtraAgentRowView, {
        row: { key: 'lane:fixture-' + index, origin: 'CLI', status: 'waiting', runtime: 'fixture',
          model: null, name: 'Review fixture with a long chat title', subtitle: '',
          lastActivityAt: Date.now() - 60000, sessionKey: 'fixture', repoPath: '/fixture',
          packetId: 'fixture', laneId: 'fixture-' + index, laneStatus: 'reviewing',
          outcome: null, outcomeNote: null, lastEventLabel: null },
        active: false, busy: false, band: 'settled', showPreview: false,
        onFocusRow: () => window.selected++, onOpenReview: () => window.opened++,
      }))),
    createElement('aside', null, createElement(WorkerReviewAction, {
      packet: { status: 'awaiting_review', title: 'Tile review fixture' },
      onOpenReview: () => window.opened++,
    }))));
};
`;

describe.skipIf(!executablePath)('sidebar review and section layout in a real browser', () => {
  let browser: Browser | undefined;
  let page: Page;
  let bundle: string;
  const browserErrors: string[] = [];

  beforeAll(async () => {
    const result = await esbuild.build({
      stdin: { contents: fixture, resolveDir: repoRoot, loader: 'jsx' },
      absWorkingDir: repoRoot, bundle: true, write: false, format: 'iife',
      platform: 'browser', target: ['chrome120'], jsx: 'automatic',
      define: { 'process.env.NODE_ENV': '"production"' },
      alias: { '@': path.join(repoRoot, 'src') },
      legalComments: 'none', logLevel: 'silent',
    });
    bundle = result.outputFiles[0].text;
    browser = await chromium.launch({ executablePath: executablePath!, headless: true });
    page = await browser.newPage({ viewport: { width: 1000, height: 1000 } });
    page.on('pageerror', error => browserErrors.push(error.message));
  }, 60_000);

  afterAll(async () => { await browser?.close(); });

  for (const theme of ['dark', 'light'] as const) {
    for (const width of [240, 400]) {
      it(`preserves icon geometry, quiet feedback and header rhythm at ${width}px in ${theme}`, async () => {
        browserErrors.length = 0;
        const tokens = resolveTheme(getPalette(theme), 'solid').cssVars;
        await page.setContent(`<!doctype html><html><head><style>${fs.readFileSync(path.join(repoRoot, 'src/app/globals.css'), 'utf8')}</style></head><body></body></html>`);
        await page.evaluate((vars) => {
          for (const [key, value] of Object.entries(vars)) document.documentElement.style.setProperty(key, value);
        }, tokens);
        await page.addScriptTag({ content: bundle });
        await page.evaluate(({ width, labels }) => {
          (window as unknown as { mountSidebar: (width: number, labels: string[]) => void }).mountSidebar(width, labels);
        }, { width, labels });
        await page.locator('[data-o8-agent-row]').first().waitFor();
        await page.evaluate(() => document.fonts.ready.then(() => undefined));
        await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

        const measurements = await page.locator('section').evaluateAll(sections => sections.map(section => {
          const header = section.firstElementChild as HTMLElement;
          const toggle = header.querySelector('button')!;
          const row = section.querySelector<HTMLElement>('[data-o8-agent-row]')!;
          const button = row.querySelector<HTMLButtonElement>('[data-worker-open-review]')!;
          const svg = button.querySelector('svg')!;
          const title = row.querySelector<HTMLElement>(':scope > span')!;
          const rowBox = row.getBoundingClientRect();
          const buttonBox = button.getBoundingClientRect();
          const svgBox = svg.getBoundingClientRect();
          return {
            rowWidth: rowBox.width, buttonWidth: buttonBox.width, buttonHeight: buttonBox.height,
            iconWidth: svgBox.width, iconHeight: svgBox.height,
            contained: svgBox.left >= buttonBox.left && svgBox.right <= buttonBox.right
              && svgBox.top >= buttonBox.top && svgBox.bottom <= buttonBox.bottom
              && buttonBox.right <= rowBox.right,
            background: getComputedStyle(button).backgroundColor,
            muted: button.style.color === 'var(--t-text-muted)',
            headerColor: header.style.color, headerSize: getComputedStyle(toggle).fontSize,
            headerWeight: getComputedStyle(toggle).fontWeight,
            above: toggle.getBoundingClientRect().top - header.getBoundingClientRect().top,
            below: rowBox.top - toggle.getBoundingClientRect().bottom,
            rowSize: getComputedStyle(title).fontSize, rowWeight: getComputedStyle(title).fontWeight,
          };
        }));
        expect(measurements).toHaveLength(labels.length);
        for (const metrics of measurements) {
          expect(metrics.rowWidth).toBe(width);
          expect(metrics.buttonWidth).toBe(20); expect(metrics.buttonHeight).toBe(20);
          expect(metrics.iconWidth).toBe(15); expect(metrics.iconHeight).toBe(15);
          expect(metrics.contained).toBe(true);
          expect(metrics.background).toBe('rgba(0, 0, 0, 0)'); expect(metrics.muted).toBe(true);
          expect(metrics.headerColor).toBe('var(--t-text-faint)');
          expect(metrics.headerSize).toBe('12.5px'); expect(metrics.headerWeight).toBe('300');
          expect(metrics.above).toBe(16); expect(metrics.below).toBe(6);
          expect(metrics.rowSize).toBe('13.5px'); expect(metrics.rowWeight).toBe('300');
        }
        const defaultButton = page.locator('aside [data-worker-open-review]');
        expect((await defaultButton.boundingBox())?.width).toBe(30);
        expect((await defaultButton.locator('svg').boundingBox())?.width).toBe(15);
        const control = page.locator('[data-o8-agent-row] [data-worker-open-review]').first();
        await control.hover();
        expect(await control.evaluate(el => (el as HTMLElement).style.background)).toBe('var(--t-hover)');
        await control.focus();
        await page.mouse.move(900, 900);
        expect(await control.evaluate(el => (el as HTMLElement).style.background)).toBe('var(--t-hover)');
        await control.press('Enter');
        expect(await page.evaluate(() => ({
          opened: (window as unknown as { opened: number }).opened,
          selected: (window as unknown as { selected: number }).selected,
        }))).toEqual({ opened: 1, selected: 0 });
        await control.evaluate(el => (el as HTMLElement).blur());
        expect(await control.evaluate(el => (el as HTMLElement).style.background)).toBe('transparent');
        expect(browserErrors).toEqual([]);
      });
    }
  }
});
