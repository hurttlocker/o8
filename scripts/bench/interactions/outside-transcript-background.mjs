#!/usr/bin/env node
// Production transcript hook/renderers; four fixture sessions share live cache updates.
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { webkit } from 'playwright-core';
import { resolveBrowserPath } from '../measure-browser-boot.mjs';
import { launchMeasuredBrowser, closeMeasuredBrowser } from './browser-runtime.mjs';
import { percentile } from './statistics.mjs';

const option = (key, fallback) => process.argv.find(value => value.startsWith(`--${key}=`))?.slice(key.length + 3) ?? fallback;
const engine = option('engine', 'chromium');
const workspace = option('surface', 'outside') === 'workspace';
const presentationFile = workspace ? 'src/components/desktop/workspace-terminal/useWorkspaceChatPane.ts' : 'src/lib/transcripts/useTranscript.ts';
const entryAttribute = workspace ? 'data-o8-message-id' : 'data-outside-transcript-entry';
const output = path.resolve(option('output', 'tests/bench/latest/outside-transcript-background.json'));
const forceForeground = process.argv.includes('--force-foreground');
const baselinePresentation = process.argv.includes('--baseline-presentation');
if (!['chromium', 'webkit'].includes(engine)) throw new Error('Use --engine=chromium|webkit.');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const baselineRef = baselinePresentation ? execFileSync('git', ['merge-base', 'HEAD', 'origin/main'], { cwd: root, encoding: 'utf8' }).trim() : null;
const receipt = { engine, surface: workspace ? 'workspace' : 'outside', forceForeground, baselineRef, observations: [], errors: [], passed: false,
  workload: { sessions: 4, entriesPerSession: 80, sourceCadenceMs: 50, samples: 3, sampleMs: 3000 },
  limits: 'Production data hook, transcript renderers and shared store with fixture cache writes. Workspace fixture uses the production draft/scroll hooks; surrounding application chrome is omitted. Existing interaction browser ownership/statistics. Not full dashboard, native, provider or power-saving proof. WebKit TaskDuration unavailable.' };
let browser; let measured;
try {
  const built = await build({ absWorkingDir: root, bundle: true, write: false, minify: true, format: 'iife',
    platform: 'browser', alias: { '@': path.join(root, 'src') },
    define: { 'process.env.NODE_ENV': '"production"', 'process.env': '{}' },
    plugins: baselinePresentation ? [{ name: 'original-presentation', setup(plugin) {
      plugin.onLoad({ filter: workspace ? /workspace-terminal\/useWorkspaceChatPane\.ts$/ : /transcripts\/useTranscript\.ts$/ }, () => ({ loader: 'ts',
        contents: execFileSync('git', ['show', `${baselineRef}:${presentationFile}`], { cwd: root, encoding: 'utf8' }),
      }));
    } }] : [],
    stdin: { resolveDir: root, loader: 'tsx', contents: `
      import React, { useEffect, useState } from 'react';
      import { createRoot } from 'react-dom/client';
      import { OutsideConversationPane } from './src/components/desktop/workspace-terminal/OutsideConversationPane';
      import { transcriptStore } from './src/lib/transcripts/store';
      ${workspace ? `import { useWorkspaceChatPane } from './src/components/desktop/workspace-terminal/useWorkspaceChatPane';
      import { WorkspaceTranscript } from './src/components/desktop/workspace-terminal/WorkspaceTranscript';
      const callbacks = {onUpdateMessages: () => {}, onUpdateSessionKey: () => {}, onSelectModel: () => {}, onConsumeDraftInjection: () => {}};
      function WorkspacePane({sessionKey, active}) {
        const tab = React.useMemo(() => ({id: sessionKey, kind: 'chat', chatRuntime: 'muse', chatSessionKey: sessionKey}), [sessionKey]);
        const chat = useWorkspaceChatPane({tab, active, ...callbacks});
        return <section style={{display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0}}>
          <div data-fixture-scroll ref={chat.scrollRef} onScroll={chat.handleScroll} style={{flex: 1, minHeight: 0, overflowY: 'auto'}}>
            <WorkspaceTranscript entries={chat.visibleTranscriptEntries} active={active} />
          </div>
          <textarea aria-label={'Draft ' + sessionKey} value={chat.draft} onChange={event => chat.setDraft(event.target.value)} />
        </section>;
      }` : ''}
      const keys = Array.from({length: 4}, (_, s) => '${workspace ? 'muse-owned' : 'codex-discovered'}:fixture-' + s);
      const histories = keys.map((_, s) => Array.from({length: 80}, (_, i) => ({
        id: 's' + s + '-e' + i, role: i % 2 ? 'assistant' : 'user', timestamp: 1,
        text: i === 79 ? 'Live 0' : '**History ' + i + '**\\n\\n' + 'Retain the original transcript position and selection. '.repeat(8),
      })));
      keys.forEach((key, s) => transcriptStore.setSlice(key, { messages: histories[s], status: 'fresh', lastUpdated: 1 }));
      window.__transcriptStatuses = () => keys.map(key => transcriptStore.getSlice(key).status);
      function Fixture() {
        const [active, setActive] = useState(0);
        useEffect(() => {
          let tick = 0;
          const timer = setInterval(() => { tick++; window.__tick = tick;
            keys.forEach((key, s) => transcriptStore.setSlice(key, {
              messages: [...histories[s].slice(0, 79), {...histories[s][79], text: 'Live ' + tick}],
              status: 'fresh', lastUpdated: tick,
            }, {deferNotifications: true}));
          }, 50);
          window.__stop = () => clearInterval(timer);
          return () => clearInterval(timer);
        }, []);
        return <main style={{width: 1000, height: 650, display: 'flex', flexDirection: 'column'}}>
          <nav>{keys.map((_, s) => <button key={s} onClick={() => setActive(s)}>Session {s}</button>)}</nav>
          {keys.map((key, s) => <div key={key} data-fixture-session={s}
            style={{display: s === active ? 'flex' : 'none', flex: 1, minHeight: 0}}>
            <${workspace ? 'WorkspacePane' : 'OutsideConversationPane'} sessionKey={key} runtime="codex" active={${forceForeground} || s === active}
              tab={{id: key, kind: 'chat', label: 'Fixture session ' + s}} />
          </div>)}
        </main>;
      }
      createRoot(document.getElementById('root')).render(<Fixture />);
    ` } });
  if (engine === 'chromium') { measured = await launchMeasuredBrowser(resolveBrowserPath(), `o8-outside-background-${process.pid}`); browser = measured.browser; }
  else browser = await webkit.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1100, height: 750 }, reducedMotion: 'reduce' });
  page.on('pageerror', error => receipt.errors.push(String(error)));
  await page.route('**/*', route => route.fulfill({ json: { transcript: [] } }));
  // Give relative history refreshes a valid origin; all requests stay routed fixtures.
  await page.goto('http://o8-transcript.invalid/', { waitUntil: 'domcontentloaded' });
  await page.setContent('<html><head><style>body{margin:0;background:#151515;color:#eee;font:14px system-ui}*{scrollbar-width:none}::-webkit-scrollbar{display:none}</style></head><body><div id="root"></div></body></html>');
  await page.addScriptTag({ content: built.outputFiles[0].text });
  const article = page.locator(`[${entryAttribute}="s0-e1"]`);
  await article.waitFor(); await page.evaluate(() => document.fonts.ready);
  const scroller = page.locator(workspace ? '[data-fixture-session="0"] [data-fixture-scroll]' : '[data-fixture-session="0"] section > div').last();
  if (workspace) {
    await page.locator('[data-fixture-session="0"] textarea').fill('Retained workspace draft');
    await page.locator('[data-fixture-session="0"] textarea').evaluate(node => node.setSelectionRange(2, 10));
  }
  await scroller.evaluate(element => { element.scrollTop = 250; });
  const scrollTop = await scroller.evaluate(element => element.scrollTop);
  const originalNode = await article.elementHandle();
  await article.evaluate(element => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let text = walker.nextNode();
    while (text && text.textContent.length < 16) text = walker.nextNode();
    const range = document.createRange(); range.setStart(text, 2); range.setEnd(text, 10);
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
  });
  const selection = await page.evaluate(() => String(window.getSelection()));
  const cdp = engine === 'chromium' ? await page.context().newCDPSession(page) : null;
  if (cdp) await cdp.send('Performance.enable');
  const taskTime = async () => cdp ? (await cdp.send('Performance.getMetrics')).metrics.find(value => value.name === 'TaskDuration').value : null;
  for (let sample = 0; sample < 3; sample++) {
    await page.evaluate(entryAttribute => {
      const epoch = window.__epoch = (window.__epoch ?? 0) + 1;
      window.__frames = []; let last = performance.now();
      const frame = now => { if (window.__epoch !== epoch) return; window.__frames.push(now - last); last = now; requestAnimationFrame(frame); };
      requestAnimationFrame(frame); window.__batches = {};
      window.__observer = new MutationObserver(mutations => {
        const changed = new Set();
        for (const mutation of mutations) {
          const element = (mutation.target.nodeType === 1 ? mutation.target : mutation.target.parentElement)?.closest(`[${entryAttribute}]`);
          if (element) changed.add(element.getAttribute(entryAttribute));
        }
        for (const id of changed) window.__batches[id] = (window.__batches[id] ?? 0) + 1;
      });
      window.__observer.observe(document.body, { subtree: true, childList: true, characterData: true });
    }, entryAttribute);
    const before = await taskTime(); const started = performance.now();
    await page.waitForTimeout(3000);
    const after = await taskTime();
    const observation = await page.evaluate(() => {
      window.__epoch++; window.__observer.disconnect();
      return { batches: window.__batches, frames: window.__frames.length,
        framesOver34ms: window.__frames.filter(ms => ms > 34).length };
    });
    const hiddenBatches = [1, 2, 3].map(s => observation.batches['s' + s + '-e79'] ?? 0);
    receipt.observations.push({ ...observation, hiddenBatches,
      visibleBatches: observation.batches['s0-e79'] ?? 0,
      taskMs: before === null ? null : (after - before) * 1000, elapsedMs: performance.now() - started,
      scrollPreserved: Math.abs(await scroller.evaluate(element => element.scrollTop) - scrollTop) <= 1 });
  }
  await page.evaluate(() => window.__stop()); await page.waitForTimeout(300);
  await page.getByRole('button', { name: 'Session 3', exact: true }).click();
  receipt.catchUp = await page.locator(`[${entryAttribute}="s3-e79"]`).evaluate(
    (element, tick) => element.textContent.includes(`Live ${tick}`), await page.evaluate(() => window.__tick));
  await page.getByRole('button', { name: 'Session 0', exact: true }).click();
  receipt.retained = await article.evaluate((node, original) => node === original, originalNode);
  receipt.scrollPreserved = Math.abs(await scroller.evaluate(element => element.scrollTop) - scrollTop) <= 1;
  receipt.selectionPreserved = await page.evaluate(() => String(window.getSelection())) === selection;
  receipt.draftRetained = !workspace || await page.locator('[data-fixture-session="0"] textarea').inputValue() === 'Retained workspace draft';
  receipt.draftSelectionRetained = !workspace || await page.locator('[data-fixture-session="0"] textarea').evaluate(node => node.selectionStart === 2 && node.selectionEnd === 10);
  receipt.transcriptHealthy = await page.evaluate(() => window.__transcriptStatuses().every(status => status === 'fresh'));
  if (option('screenshot', '')) await page.screenshot({ path: path.resolve(option('screenshot', '')) });
  receipt.medianTaskMs = percentile(receipt.observations.map(row => row.taskMs), 0.5);
  receipt.passed = !receipt.errors.length && receipt.draftRetained && receipt.draftSelectionRetained && receipt.transcriptHealthy && receipt.catchUp && receipt.retained && receipt.scrollPreserved && receipt.selectionPreserved
    && receipt.observations.every(row => row.scrollPreserved && row.visibleBatches >= 8 && row.hiddenBatches.every(count => count > 0 && count <= 4));
} catch (error) { receipt.error = String(error); }
finally {
  if (measured) await closeMeasuredBrowser(measured); else await browser?.close();
  await mkdir(path.dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(receipt, null, 2) + '\n');
  console.log('[outside-transcript-background]', JSON.stringify(receipt));
  if (!receipt.passed) process.exitCode = 1;
}
