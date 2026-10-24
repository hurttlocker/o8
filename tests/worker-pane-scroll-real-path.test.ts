import path from 'node:path';
import esbuild from 'esbuild';
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveBrowserPath } from '../scripts/bench/measure-browser-boot.mjs';

const executablePath = resolveBrowserPath();
const fixture = `
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { AgentTilePane } from '@/components/desktop/workspace-terminal/AgentTilePane';
import { transcriptStore } from '@/lib/transcripts/store';
const sessionKey = 'codex-owned:scroll-fixture';
let root;
const entry = index => ({ id: 'event-' + index, role: 'assistant', text: 'Worker event ' + index + '\\n\\nA persisted transcript message with enough text to wrap inside the worker pane.' });
window.fetch = async () => Response.json({ agents: [], events: [] });
window.feed = count => transcriptStore.mergeEntries(sessionKey, Array.from({ length: count }, (_, index) => entry(index)));
window.mountPane = (count, finished = false) => {
  root?.unmount(); document.body.replaceChildren();
  transcriptStore.setSlice(sessionKey, { messages: Array.from({ length: count }, (_, index) => entry(index)), status: 'fresh', lastUpdated: 1 });
  const host = document.createElement('main');
  Object.assign(host.style, { width: '430px', height: '420px', display: 'flex' });
  document.body.append(host); root = createRoot(host);
  root.render(createElement(AgentTilePane, { sessionKey, agent: { name: 'Worker', runtime: 'codex', status: finished ? 'completed' : 'running' }, focused: true, onFocus() {}, onClose() {} }));
};
`;

declare global {
  interface Window {
    mountPane: (count: number, finished?: boolean) => void;
    feed: (count: number) => void;
  }
}

describe.skipIf(!executablePath)('worker pane follow behavior in a real browser', () => {
  let browser: Browser | undefined;
  let page: Page;
  const errors: string[] = [];
  const scroller = '[data-worker-pane] > div[style*="overflow-y: auto"]';

  beforeAll(async () => {
    const result = await esbuild.build({
      stdin: { contents: fixture, resolveDir: process.cwd(), loader: 'jsx' },
      bundle: true, write: false, format: 'iife', platform: 'browser', target: ['chrome120'], jsx: 'automatic',
      define: { 'process.env.NODE_ENV': '"production"', 'process.env': '{}' },
      alias: { '@': path.join(process.cwd(), 'src') }, logLevel: 'silent',
      plugins: [{ name: 'unrelated-session-transform', setup(build) {
        build.onResolve({ filter: /SessionTransformMenu$/ }, () => ({ path: 'transform', namespace: 'fixture' }));
        build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export const SessionTransformMenu = () => null;' }));
      } }],
    });
    browser = await chromium.launch({ executablePath: executablePath!, headless: true });
    page = await browser.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.setContent('<!doctype html><html><body></body></html>');
    await page.addScriptTag({ content: result.outputFiles[0].text });
    expect(errors).toEqual([]);
  }, 60_000);

  afterAll(async () => { await browser?.close(); });

  const distance = () => page.locator(scroller).evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight);
  const settle = () => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

  it('follows 200 events, preserves a scrolled-up view and re-pins with one click', async () => {
    await page.evaluate(() => window.mountPane(150));
    await page.locator('[data-o8-message-id="event-149"]').waitFor();
    await settle();
    expect(await distance()).toBeLessThan(8);
    for (let count = 151; count <= 200; count += 1) {
      await page.evaluate(count => window.feed(count), count);
      await settle();
      expect(await distance(), `event ${count}`).toBeLessThan(8);
    }
    await page.locator(scroller).evaluate(el => { el.scrollTop -= el.clientHeight * 2; });
    await settle();
    const anchor = page.locator('[data-o8-message-id="event-180"]');
    const previousTop = (await anchor.boundingBox())!.y;
    await page.evaluate(() => window.feed(201));
    await settle();
    expect((await anchor.boundingBox())!.y).toBe(previousTop);
    const jump = page.getByRole('button', { name: /new messages|jump to latest/i });
    expect(await jump.count()).toBe(1);
    await jump.click();
    await settle();
    expect(await distance()).toBeLessThan(8);
    await page.evaluate(() => window.feed(202));
    await settle();
    expect(await distance()).toBeLessThan(8);
    expect(await jump.count()).toBe(0);
    expect(errors).toEqual([]);
  });

  it('mounts and remounts a finished worker at its final message', async () => {
    for (let mount = 0; mount < 2; mount += 1) {
      await page.evaluate(() => window.mountPane(200, true));
      await page.locator('[data-o8-message-id="event-199"]').waitFor();
      await settle();
      expect(await distance()).toBeLessThan(8);
    }
    expect(errors).toEqual([]);
  });
});
