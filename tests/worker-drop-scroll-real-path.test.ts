// Real responsive surface and pointer-drag protocol; worker content is a fixture.
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium, webkit, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveBrowserPath } from '../scripts/bench/measure-browser-boot.mjs';

const proof = process.env.O8_WORKER_DROP_PROOF_DIR;
let bundle: string;
const fixture = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ResponsiveSessionSurface } from '@/components/desktop/workspace-terminal/ResponsiveSessionSurface';
import { addSessionToLayout, createDefaultSessionTileLayout } from '@/lib/orchestrator/session-tiles';
import { trackThreadDrag } from '@/lib/workspace-terminal/thread-drag';
const layout = Array.from({ length: 10 }, (_, index) => 'worker:' + index)
  .reduce((value, key) => addSessionToLayout(value, key), createDefaultSessionTileLayout());
window.fixtureDrops = [];
function Fixture() {
  const [active, setActive] = useState(true);
  window.fixtureActive = setActive;
  return <main style={{ display: 'flex', height: 740, width: 1100, position: 'relative' }}>
    <ResponsiveSessionSurface active={active} layout={layout} focusedSessionKey={null}
      onThreadDrop={action => window.fixtureDrops.push(action)} onResizeSplit={() => {}} onCloseLeaf={() => {}} onFocusSession={() => {}}
      chatSlot={<div><button onPointerDown={event => trackThreadDrag(event, { threadId: 'fixture-thread', title: 'Fixture thread', mode: 'orchestrator' }, { source: event.currentTarget })}>Drag fixture thread</button><textarea defaultValue="Retained chat draft" /></div>}
      renderSessionPane={leaf => <div data-worker-fixture={leaf.id} style={{ flex: 1, background: '#27313d', color: 'white' }}>{leaf.sessionKey}</div>} />
  </main>;
}
createRoot(document.getElementById('root')).render(<Fixture />);
`;
beforeAll(async () => {
  const result = await build({ stdin: { contents: fixture, resolveDir: process.cwd(), loader: 'jsx' },
    bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' }, alias: { '@': resolve('src') }, logLevel: 'silent',
    plugins: [{ name: 'unused-pane-boundaries', setup(plugin) {
      plugin.onResolve({ filter: /\/(SessionTranscriptPane|ThreadChatPane|LiveSessionMesh)$/ }, (args) => ({ path: args.path, namespace: 'unused' }));
      plugin.onLoad({ filter: /.*/, namespace: 'unused' }, () => ({ contents: 'export const SessionTranscriptPane = () => null; export const ThreadChatPane = () => null; export const projectLiveSessionMeshParticipants = () => [];' }));
    } }],
  });
  bundle = result.outputFiles[0].text;
  if (proof) mkdirSync(proof, { recursive: true });
});
for (const engine of ['chromium', 'webkit'] as const) describe.runIf(engine === 'webkit'
  ? existsSync(webkit.executablePath()) : Boolean(resolveBrowserPath()))(`worker drop scrolling in ${engine}`, () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = engine === 'webkit' ? await webkit.launch({ headless: true })
      : await chromium.launch({ executablePath: resolveBrowserPath()!, headless: true });
  });
  afterAll(async () => { await browser?.close(); });
  async function start() {
    const page = await browser.newPage({ viewport: { width: 1100, height: 800 }, reducedMotion: 'reduce' });
    await page.route('**/*', route => route.abort());
    await page.setContent('<html><body style="margin:0;background:#141414;color:white"><div id="root"></div></body></html>');
    await page.addScriptTag({ content: bundle });
    const scroll = page.locator('[data-session-worker-scroll="true"]');
    await scroll.waitFor();
    const pane = page.locator('[data-session-tile-leaf-id]').nth(1);
    const bounds = await pane.boundingBox();
    const button = await page.getByRole('button', { name: 'Drag fixture thread' }).boundingBox();
    const point = { x: bounds!.x + bounds!.width * 0.75, y: 100 };
    await page.mouse.move(button!.x + 10, button!.y + 10); await page.mouse.down();
    await page.mouse.move(point.x, point.y, { steps: 5 });
    await page.locator('[data-thread-drop-layer] > div').waitFor();
    return { page, pane, scroll, point };
  }
  async function aligned(page: Page, pane: ReturnType<Page['locator']>) {
    const expected = await pane.boundingBox();
    const host = await page.locator('[data-thread-drop-layer]').boundingBox();
    const preview = await page.locator('[data-thread-drop-layer] > div').boundingBox();
    return expected && host && preview
      ? Math.abs(preview.y - Math.max(host.y, expected.y)) < 1
        && Math.abs(preview.height - (Math.min(host.y + host.height, expected.y + expected.height) - Math.max(host.y, expected.y))) < 1
      : false;
  }
  for (const move of [false, true]) it(`aligns the same pane after scrolling ${move ? 'and moving' : 'under a stationary pointer'}`, async () => {
    const { page, pane, scroll, point } = await start();
    try {
      expect(await aligned(page, pane)).toBe(true);
      const original = await pane.elementHandle();
      await page.mouse.wheel(0, 80);
      await expect.poll(() => scroll.evaluate(element => element.scrollTop)).toBeGreaterThan(50);
      if (move) await page.mouse.move(point.x + 2, point.y);
      try { await expect.poll(() => aligned(page, pane)).toBe(true); }
      finally { if (proof) await page.screenshot({ path: join(proof, `${engine}-${move ? 'move' : 'stationary'}.png`) }); }
      const id = await pane.getAttribute('data-session-tile-leaf-id');
      await page.mouse.up();
      await expect.poll(() => page.evaluate(() => (window as unknown as { fixtureDrops: unknown[] }).fixtureDrops.length)).toBe(1);
      expect(await page.evaluate(() => (window as unknown as { fixtureDrops: Array<{ leafId: string }> }).fixtureDrops[0].leafId)).toBe(id);
      expect(await original!.evaluate(element => element === document.querySelectorAll('[data-session-tile-leaf-id]')[1])).toBe(true);
      expect(await page.locator('textarea').inputValue()).toBe('Retained chat draft');
    } finally { await page.mouse.up(); await page.close(); }
  });
  it('refuses a scrolled drop after the workspace becomes inactive', async () => {
    const { page, scroll } = await start();
    try {
      await scroll.evaluate(element => {
        element.scrollTop = 80;
        (window as unknown as { fixtureActive(value: boolean): void }).fixtureActive(false);
      });
      await expect.poll(() => page.locator('[data-thread-drop-layer] > div').count()).toBe(0);
      await page.mouse.up();
      expect(await page.evaluate(() => (window as unknown as { fixtureDrops: unknown[] }).fixtureDrops)).toEqual([]);
    } finally { await page.mouse.up(); await page.close(); }
  });
});
