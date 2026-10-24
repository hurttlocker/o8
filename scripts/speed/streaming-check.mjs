#!/usr/bin/env node
import { distribution, evidencePath, sleep } from './common.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, startStack } from './stack.mjs';
import { openBrowser } from './ui.mjs';
const label = 'streaming-check';
const dir = evidencePath(process.argv.find(value => value.startsWith('--output='))?.slice(9) ?? 'work/streaming-check');
fs.mkdirSync(dir, { recursive: true });
const receipt = { label, observations: [], profiles: [], errors: [] };
let stack, ui;
try {
  const seeded = fixture(dir);
  stack = await startStack(seeded, dir);
  ui = await openBrowser(stack, seeded);
  const transport = await ui.context.newCDPSession(ui.page);
  await transport.send('Network.enable');
  const nativeFrame = new Promise(resolve => transport.once('Network.webSocketFrameReceived', resolve));
  ui.advance();
  receipt.nativeWebSocket = Boolean(await Promise.race([nativeFrame, sleep(1000).then(() => null)]));
  await transport.send('Network.disable'); await transport.detach();
  await ui.page.waitForFunction(() => document.querySelector('[data-o8-message-id="speed-0-message-299"]').textContent.includes('Streaming sample 1.'), null, { timeout: 5000 });
  if (!receipt.nativeWebSocket) receipt.errors.push('The fixture did not deliver a native WebSocket frame');
  await ui.page.screenshot({ path: path.join(dir, 'boot.png'), animations: 'disabled', caret: 'hide' });

  for (let repetition = 1; repetition <= 3; repetition++) {
    for (const sessions of repetition % 2 ? [1, 4] : [4, 1]) {
      const row = { repetition, ...await ui.measure(sessions) };
      receipt.observations.push(row);
      console.log(JSON.stringify({label, repetition, sessions, taskMsPerSecond: row.taskMs * 1000 / row.durationMs, inputP95: row.keystrokeMs.p95, subscribers: row.subscribedSessions}));
    }
  }
  if (process.argv.includes('--trace')) {
    const cdp = await ui.context.newCDPSession(ui.page);
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: 500 });
    for (const sessions of [1, 4]) {
      const events = [];
      const receive = ({value}) => events.push(...value);
      cdp.on('Tracing.dataCollected', receive);
      await cdp.send('Tracing.start', { categories: 'devtools.timeline,v8,disabled-by-default-devtools.timeline,disabled-by-default-v8.cpu_profiler', options: 'sampling-frequency=2000', transferMode: 'ReportEvents' });
      await cdp.send('Profiler.start');
      const row = await ui.measure(sessions);
      const {profile} = await cdp.send('Profiler.stop');
      const complete = new Promise(resolve => cdp.once('Tracing.tracingComplete', resolve));
      await cdp.send('Tracing.end'); await complete;
      cdp.off('Tracing.dataCollected', receive);
      fs.writeFileSync(path.join(dir, `trace-${sessions}.json`), JSON.stringify({traceEvents: events}));
      fs.writeFileSync(path.join(dir, `cpu-${sessions}.json`), JSON.stringify(profile));
      receipt.profiles.push(row);
    }
  }
  const scrollState = async action => ui.page.evaluate(action => {
    const transcript = [...document.querySelectorAll('[data-worker-transcript]')].find(node => node.getBoundingClientRect().width > 0 && getComputedStyle(node).visibility === 'visible');
    const scroller = transcript.closest('.cortex-scroll-fade-y');
    if (action === 'bottom') scroller.scrollTop = scroller.scrollHeight;
    if (action === 'up') scroller.scrollTop -= 500;
    if (action) scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
    const order = [...transcript.querySelectorAll('[data-o8-message-id]')].map(node => node.getAttribute('data-o8-message-id'));
    return { top: scroller.scrollTop, distance: scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight,
      ordered: order.length === 200 && order.every((id, index) => id === `speed-0-message-${index + 100}`) };
  }, action);
  const advanceVisible = async () => {
    const marker = await ui.page.locator('[data-o8-message-id="speed-0-message-299"]').textContent();
    ui.advance();
    await ui.page.waitForFunction(marker => document.querySelector('[data-o8-message-id="speed-0-message-299"]').textContent !== marker, marker);
    await ui.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  };
  const pinnedBefore = await scrollState('bottom'); await advanceVisible(); const pinnedAfter = await scrollState();
  const unpinnedBefore = await scrollState('up'); await advanceVisible(); const unpinnedAfter = await scrollState();
  await ui.page.getByTitle('Jump to latest message', { exact: true }).click();
  await advanceVisible(); const jumped = await scrollState();
  receipt.behavior = { pinnedBefore, pinnedAfter, unpinnedBefore, unpinnedAfter, jumped };
  if (!pinnedAfter.ordered || pinnedAfter.distance > 1 || Math.abs(unpinnedAfter.top - unpinnedBefore.top) > 1 || jumped.distance > 1) throw new Error('Transcript order or pinning changed');
  await ui.composer.fill('Line\n'.repeat(40));
  await ui.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const grown = await ui.composer.evaluate(node => node.getBoundingClientRect().height);
  await ui.composer.fill('baseline');
  await ui.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const shrunk = await ui.composer.evaluate(node => node.getBoundingClientRect().height);
  receipt.composerSizing = { grown, shrunk };
  if (grown <= 52 || grown > 201 || Math.abs(shrunk - 52) > 1) throw new Error('Composer sizing changed');
  await ui.page.evaluate(() => {
    const input = document.querySelector('textarea[data-o8-active-composer="true"]');
    input.addEventListener('keydown', () => { const start = performance.now(); while (performance.now() - start < 150) {} }, true);
  });
  receipt.calibrationMs = await ui.key();
  receipt.errors.push(...ui.errors);
} catch (error) { receipt.errors.push(error.message); }
finally { await ui?.close(); await stack?.close(); }
receipt.summaries = [1, 4].map(sessions => {
  const rows = receipt.observations.filter(row => row.sessions === sessions);
  return { sessions, mainThreadMsPerSecond: distribution(rows.map(row => row.taskMs * 1000 / row.durationMs)),
    inputMs: distribution(rows.flatMap(row => row.keystrokeMs.samples)), subscribedSessions: rows.map(row => row.subscribedSessions) };
});
for (const row of receipt.summaries) {
  if (row.mainThreadMsPerSecond.median === null || row.mainThreadMsPerSecond.median >= 100) receipt.errors.push(`producers=${row.sessions}: main-thread median must be under 100 ms/s`);
  if (row.inputMs.p95 === null || row.inputMs.p95 >= 50) receipt.errors.push(`producers=${row.sessions}: input p95 must be under 50 ms`);
}
if (receipt.observations.some(row => row.inputFailures.length || !row.visibleTranscriptAdvanced)) receipt.errors.push('A streaming observation did not deliver visible text or accepted input');
if (!receipt.calibrationMs || receipt.calibrationMs < 150 || receipt.calibrationMs >= 5000) receipt.errors.push('The input probe did not detect the injected 150 ms stall');
fs.writeFileSync(path.join(dir, 'receipt.json'), JSON.stringify(receipt, null, 2));
console.log(JSON.stringify({ summaries: receipt.summaries, behavior: receipt.behavior }));
console.log(JSON.stringify({label, errors: receipt.errors, calibration: receipt.calibrationMs}));
if (receipt.errors.length) process.exitCode = 1;
