// Render production history grouping and rows with global CSS, without a server or live data.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveBrowserPath } from '../scripts/bench/measure-browser-boot.mjs';
import { getPalette, resolveTheme } from '../src/lib/theme/registry';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = process.env.O8_SIDEBAR_SOURCE_ROOT || repoRoot;
const proofDir = process.env.O8_SIDEBAR_PROOF_DIR;
const proofState = process.env.O8_SIDEBAR_PROOF_STATE;
const executablePath = resolveBrowserPath();
const labels = ['Pinned', 'Recents', 'Today', 'Yesterday', 'Previous 7 days', 'Archived'];
const fixture = `
import { createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ExtraAgentRowView } from '@/components/desktop/AgentPanelExtraAgentRow';
import { CompactChatHistory } from '@/components/desktop/repo-focus/tabs/chats/CompactChatHistory';
import { ChatHistoryShelf } from '@/components/desktop/repo-focus/tabs/chats/ChatHistoryShelf';
import { HistoryChatRow, ArchivedLaneCompactRow, MergedPacketRow } from '@/components/desktop/repo-focus/tabs/chats/HistoryRows';
import { WorkerReviewAction } from '@/components/desktop/workspace-terminal/WorkerReviewAction';
const titles = ['Review sidebar changes', 'Plan the next release', 'Investigate saved state', 'Polish keyboard navigation'];
const items = [0, 0, 1, 3].flatMap((days, group) => titles.map((title, index) => {
  const date = new Date(); date.setDate(date.getDate() - days); date.setHours(12, 0, 0, 0);
  return { tabId: 'history-' + group + '-' + index, title, modifiedAt: date.toISOString(),
    savedAt: date.toISOString(), pinned: group === 0, starred: false, empty: false,
    messageCount: 3, model: 'fixture', preview: '', index };
}));
const renderRow = item => createElement('div', { key: item.tabId, 'data-sidebar-fixture-row': item.tabId },
  item.index === 0 ? createElement(ExtraAgentRowView, {
    row: { key: 'lane:' + item.tabId, origin: 'CLI', status: 'waiting', runtime: 'fixture',
      model: null, name: item.title, subtitle: '', lastActivityAt: Date.now() - 60000,
      sessionKey: 'fixture', repoPath: '/fixture', packetId: 'fixture', laneId: item.tabId,
      laneStatus: 'reviewing', outcome: null, outcomeNote: null, lastEventLabel: null },
    active: false, busy: false, band: 'neutral', showPreview: false,
    onFocusRow: () => window.selected++, onOpenReview: () => window.opened++,
  }) : item.index === 3 ? createElement(MergedPacketRow, {
    packet: { title: item.title, lastEventAt: item.modifiedAt }, compact: true,
  }) : createElement(HistoryChatRow, { item, active: item.pinned && item.index === 1,
    disabled: false, compact: true, onOpen: () => window.selected++,
  }));
function TileControl() {
  const [state, setState] = useState({ status: 'awaiting_review', enabled: true });
  window.setTileReview = setState;
  return createElement(WorkerReviewAction, { packet: { status: state.status, title: 'Tile review fixture' },
    onOpenReview: state.enabled ? () => window.opened++ : undefined });
}
let root;
window.mountSidebar = width => {
  root?.unmount(); document.body.replaceChildren();
  const host = document.createElement('main');
  host.style.width = width + 'px'; host.style.background = 'var(--t-sidebar-bg)';
  host.style.color = 'var(--t-text)'; host.style.fontFamily = 'var(--font-sans-system)';
  document.body.append(host); window.opened = 0; window.selected = 0;
  root = createRoot(host);
  root.render(createElement('div', null,
    createElement(CompactChatHistory, {
      chatGroupBy: 'chronological', updateChatGroupBy: () => {}, priority: [], remainder: [],
      flatHistoryItems: items, flatHistoryDateGroups: [], flatHistoryRepoGroups: [],
      collapsedRepoGroups: new Set(), repoByGroupKey: new Map(), toggleRepoGroup: () => {},
      renderHistoryRow: renderRow, hiddenChatCount: 0, showMore: () => {}, fixtures: [],
      onOpenHistoryChat: () => window.selected++,
    }),
    createElement(ChatHistoryShelf, { label: 'Archived' },
      ...items.slice(0, 4).map((item, index) => createElement('div', {
        key: item.tabId, 'data-sidebar-fixture-row': 'archived-' + index,
      }, index < 2 ? createElement(HistoryChatRow, { item, active: false, disabled: false,
        compact: true, onOpen: () => window.selected++ }) : createElement(ArchivedLaneCompactRow, {
        lane: { id: item.tabId, label: item.title, sessionKey: 'fixture', updatedAt: item.modifiedAt },
        onSelectSession: () => window.selected++,
      })))),
    createElement('aside', null, createElement(TileControl))));
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
      alias: { '@': path.join(sourceRoot, 'src') },
      nodePaths: [path.join(repoRoot, 'node_modules')],
      legalComments: 'none', logLevel: 'silent',
    });
    bundle = result.outputFiles[0].text;
    browser = await chromium.launch({ executablePath: executablePath!, headless: true });
    page = await browser.newPage({ viewport: { width: 1000, height: 1200 } });
    page.on('pageerror', error => browserErrors.push(error.message));
  }, 60_000);

  afterAll(async () => { await browser?.close(); });

  for (const theme of ['dark', 'light'] as const) {
    for (const width of [240, 400]) {
      it(`preserves icon geometry, quiet feedback and header rhythm at ${width}px in ${theme}`, async () => {
        browserErrors.length = 0;
        const tokens = resolveTheme(getPalette(theme), 'solid').cssVars;
        await page.setContent(`<!doctype html><html><head><style>${fs.readFileSync(path.join(sourceRoot, 'src/app/globals.css'), 'utf8')}</style></head><body></body></html>`);
        await page.evaluate((vars) => {
          for (const [key, value] of Object.entries(vars)) document.documentElement.style.setProperty(key, value);
        }, tokens);
        await page.addScriptTag({ content: bundle });
        await page.evaluate(width => {
          (window as unknown as { mountSidebar: (width: number) => void }).mountSidebar(width);
        }, width);
        await page.locator('[data-o8-agent-row]').first().waitFor();
        await page.evaluate(() => document.fonts.ready.then(() => undefined));
        await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

        const measurements = await page.locator('section').evaluateAll(sections => sections.map(section => {
          const header = section.firstElementChild as HTMLElement;
          const toggle = header.querySelector('button')!;
          const row = section.querySelector<HTMLElement>(':scope > div > [data-sidebar-fixture-row] > *');
          return {
            label: toggle.textContent, headerColor: header.style.color,
            headerSize: getComputedStyle(toggle).fontSize, headerWeight: getComputedStyle(toggle).fontWeight,
            above: toggle.getBoundingClientRect().top - header.getBoundingClientRect().top,
            below: row ? row.getBoundingClientRect().top - toggle.getBoundingClientRect().bottom : null,
          };
        }));
        const icons = await page.locator('[data-o8-agent-row] [data-worker-open-review]').evaluateAll(buttons => buttons.map(button => {
          const svgBox = button.querySelector('svg')!.getBoundingClientRect();
          const buttonBox = button.getBoundingClientRect();
          const rowBox = button.closest('[data-o8-agent-row]')!.getBoundingClientRect();
          return {
            buttonWidth: buttonBox.width, buttonHeight: buttonBox.height,
            iconWidth: svgBox.width, iconHeight: svgBox.height,
            contained: svgBox.left >= buttonBox.left && svgBox.right <= buttonBox.right
              && svgBox.top >= buttonBox.top && svgBox.bottom <= buttonBox.bottom && buttonBox.right <= rowBox.right,
            background: getComputedStyle(button).backgroundColor,
            muted: (button as HTMLElement).style.color === 'var(--t-text-muted)',
          };
        }));
        const rows = await page.locator('[data-sidebar-fixture-row] > *').evaluateAll(nodes => nodes.map(node => ({
          height: node.getBoundingClientRect().height, width: node.getBoundingClientRect().width,
          radius: getComputedStyle(node).borderRadius,
          textLeft: node.querySelector(':scope > span:not([aria-hidden])')!.getBoundingClientRect().left - node.getBoundingClientRect().left,
        })));
        const nestedGap = await page.locator('[aria-label="Recents conversations"]').evaluate(section => {
          const parent = section.firstElementChild!.querySelector('button')!.getBoundingClientRect();
          const child = section.querySelector('section')!.firstElementChild!.querySelector('button')!.getBoundingClientRect();
          return child.top - parent.bottom;
        });
        console.info('sidebar-layout', JSON.stringify({ theme, width, measurements, icons, rows, nestedGap }));
        // Capture before assertions so a baseline failure still carries visual proof.
        if (proofDir && proofState) {
          fs.mkdirSync(proofDir, { recursive: true });
          const panel = await page.locator('main').boundingBox();
          const lastSection = await page.locator('section').last().boundingBox();
          if (!panel || !lastSection) throw new Error('Sidebar screenshot has no rendered panel');
          await page.screenshot({ path: path.join(proofDir, `sidebar-review-${theme}-${width}-${proofState}.png`),
            clip: { ...panel, height: lastSection.y + lastSection.height - panel.y } });
        }
        expect(measurements.map(metrics => metrics.label)).toEqual(labels);
        expect(rows).toHaveLength(20);
        expect(icons).toHaveLength(4);
        for (const metrics of icons) {
          expect(metrics.iconWidth, 'review SVG must have non-zero rendered width inside a sidebar row').toBeGreaterThan(0);
          expect(metrics.buttonWidth).toBe(20); expect(metrics.buttonHeight).toBe(20);
          expect(metrics.iconWidth).toBe(15); expect(metrics.iconHeight).toBe(15);
          expect(metrics.contained).toBe(true);
          expect(metrics.background).toBe('rgba(0, 0, 0, 0)'); expect(metrics.muted).toBe(true);
        }
        for (const metrics of measurements) {
          expect(metrics.headerColor).toBe('var(--t-text-faint)');
          expect(metrics.headerSize).toBe('12px'); expect(metrics.headerWeight).toBe('300');
          expect(metrics.above).toBe(metrics.label === 'Today' ? 8 : metrics.label === 'Pinned' ? 17 : 16);
          if (metrics.below !== null) expect(metrics.below).toBe(metrics.label === 'Pinned' ? 7 : 6);
        }
        expect(nestedGap).toBe(14);
        for (const row of rows) {
          expect(row.height).toBe(28); expect(row.width).toBe(width); expect(row.radius).toBe('8px');
          expect(row.textLeft).toBe(12);
        }
        expect(await page.locator('[data-sidebar-fixture-row="history-0-1"] > div > span[aria-hidden]').evaluate(el => (el as HTMLElement).style.borderRadius)).toBe('8px');
        const defaultButton = page.locator('aside [data-worker-open-review]');
        expect((await defaultButton.boundingBox())?.width).toBe(30);
        expect((await defaultButton.locator('svg').boundingBox())?.width).toBe(15);
        const control = page.locator('[data-o8-agent-row] [data-worker-open-review]').first();
        await control.hover();
        expect(await control.evaluate(el => (el as HTMLElement).style.background)).toBe('var(--t-hover)');
        await control.focus(); await page.mouse.move(900, 1100);
        expect(await control.evaluate(el => (el as HTMLElement).style.background)).toBe('var(--t-hover)');
        await control.press('Enter');
        expect(await page.evaluate(() => ({
          opened: (window as unknown as { opened: number }).opened,
          selected: (window as unknown as { selected: number }).selected,
        }))).toEqual({ opened: 1, selected: 0 });
        await control.evaluate(el => (el as HTMLElement).blur());
        expect(await control.evaluate(el => (el as HTMLElement).style.background)).toBe('transparent');
        for (const hidden of [{ status: 'running', enabled: true }, { status: 'awaiting_review', enabled: false }]) {
          await defaultButton.focus();
          await page.evaluate(state => (window as unknown as {
            setTileReview: (state: typeof hidden) => void;
          }).setTileReview(state), hidden);
          await expect.poll(() => defaultButton.count()).toBe(0);
          await page.evaluate(() => (window as unknown as {
            setTileReview: (state: { status: string; enabled: boolean }) => void;
          }).setTileReview({ status: 'awaiting_review', enabled: true }));
          await defaultButton.waitFor();
          expect(await defaultButton.evaluate(el => (el as HTMLElement).style.background)).toBe('transparent');
          await defaultButton.press('Enter');
        }
        expect(await page.evaluate(() => (window as unknown as { opened: number }).opened)).toBe(3);
        expect(browserErrors).toEqual([]);
      });
    }
  }
});
