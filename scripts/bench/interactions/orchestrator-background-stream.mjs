#!/usr/bin/env node
// Real dashboard and stream handler; provider output and history are fixtures.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { webkit } from 'playwright-core';
import { resolveBrowserPath } from '../measure-browser-boot.mjs';
import { startIsolatedStack } from '../terminal-workload/runtime.mjs';
import { buildFixturePlan, materializeFixture } from './fixtures.mjs';
import { launchMeasuredBrowser, closeMeasuredBrowser } from './browser-runtime.mjs';
import { instrumentationInitScript } from './page-instrumentation.mjs';

const option = (key, fallback) => process.argv.find(value => value.startsWith(`--${key}=`))?.slice(key.length + 3) ?? fallback;
const engine = option('engine', 'chromium');
const samples = Number(option('samples', '3'));
const output = path.resolve(option('output', 'tests/bench/latest/orchestrator-background-stream.json'));
const label = option('label', 'observation');
const expectThrottle = process.argv.includes('--expect-background-throttle');
if (!['chromium', 'webkit'].includes(engine) || !Number.isInteger(samples) || samples < 1 || samples > 5) {
  throw new Error('Use --engine=chromium|webkit and --samples=1..5.');
}
if (!fs.existsSync('.next/BUILD_ID')) throw new Error('A production build is required.');
const plan = buildFixturePlan(1, 3462);
plan.tabs = Array.from({ length: 4 }, (_, index) => ({
  id: `fixture-orch-${index + 1}`, label: `Stream ${index + 1}`, kind: 'orchestrator',
  orchestratorThreadId: `thoughts-measure-${index + 1}`, mode: 'fleet',
}));
const fixture = materializeFixture(plan);
const stateFile = path.join(fixture.dataDir, 'terminal-states/tile-root.json');
const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
state.activeTabId = plan.tabs[0].id;
fs.writeFileSync(stateFile, JSON.stringify(state));
const histories = plan.tabs.map((_, session) => Array.from({ length: 80 }, (_, index) => ({
  id: `orch-${session + 1}-msg-${index}`, role: index % 2 ? 'assistant' : 'user',
  content: index % 2
    ? `Session ${session + 1} response ${index}.\n\nKeep the selected folder and draft.\n\n\`\`\`typescript\nconst result = { complete: true, sequence: ${index} };\n\`\`\`\n`
    : `Session ${session + 1} request ${index}: preserve the original input.`,
  timestamp: 1700000000000 + index * 1000,
})));
const receipt = {
  label, engine, buildSource: option('build-source', 'unspecified'), expectThrottle, head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  buildId: fs.readFileSync('.next/BUILD_ID', 'utf8').trim(),
  workload: { tabs: 4, entriesPerThread: 80, ticks: 200, cadenceMs: 50, samples, simulated: true },
  limits: 'Fixture provider output; actual dashboard residency. WebKit lacks CDP TaskDuration. No native/provider or power-saving claim.',
  subscriptions: [], observations: [], errors: [],
};
let stack;
let measured;
let browser;
let sequence = 0;
const sockets = new Map();
const send = (socket, threadId, event, data) => socket.send(JSON.stringify({
  channel: 'orchestrator', event, seq: ++sequence, data: { threadId, ...data },
}));
try {
  stack = await startIsolatedStack(process.cwd(), fixture, 'production', { runTag: `o8-3462-${process.pid}` });
  if (engine === 'chromium') {
    measured = await launchMeasuredBrowser(resolveBrowserPath(), `o8-3462-${process.pid}`);
    browser = measured.browser;
  } else browser = await webkit.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 },
    extraHTTPHeaders: { Authorization: `Bearer ${stack.token}` } });
  await context.route('**/api/runtime/inventory**', route => route.fulfill({ json: { agents: [] } }));
  await context.route('**/api/v2/chat-history**', route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/list')) return route.fulfill({ json: { conversations: [] } });
    if (route.request().method() !== 'GET') return route.fulfill({ json: { ok: true } });
    const index = plan.tabs.findIndex(tab => tab.orchestratorThreadId === url.searchParams.get('tabId'));
    return route.fulfill({ json: { messages: histories[index] ?? [], backend: 'codex', page: { hasMore: false } } });
  });
  await context.routeWebSocket('**/*', socket => {
    socket.onClose(() => sockets.delete(socket));
    socket.onMessage(raw => {
      const message = JSON.parse(String(raw));
      if (message.type === 'ping') socket.send(JSON.stringify({ channel: 'pong', event: 'pong' }));
      if (message.type === 'orchestrator-subscribe') {
        sockets.set(socket, message.threadId);
        receipt.subscriptions.push({ threadId: message.threadId, since: message.since });
        send(socket, message.threadId, 'status', { status: 'ready', snapshot: true, turn: null });
      }
      if (message.type === 'orchestrator-unsubscribe') sockets.delete(socket);
    });
    setTimeout(() => socket.send(JSON.stringify({ channel: 'system', event: 'connected', data: { bootId: 'orchestrator-measure' } })), 50);
  });
  const page = await context.newPage();
  page.on('pageerror', error => receipt.errors.push(String(error)));
  await page.addInitScript(instrumentationInitScript, { selectedRepoId: plan.repos[0].name });
  await page.goto(`http://127.0.0.1:${stack.apiPort}/dashboard`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction(() => document.documentElement.getAttribute('data-o8-dashboard-hydrated') === '1', null, { timeout: 90000 });
  const activate = async index => {
    await page.locator(`[data-o8-workspace-tab="${plan.tabs[index].id}"]`).click();
    await page.locator(`[data-o8-message-id="orch-${index + 1}-msg-79"]`).waitFor({ state: 'visible', timeout: 30000 });
  };
  for (const index of [1, 2, 3, 0]) await activate(index);
  await page.waitForTimeout(1000);
  const scroller = page.locator('[data-o8-active-chat="true"]');
  await scroller.evaluate(element => { element.scrollTop = element.scrollHeight / 3; });
  await scroller.dispatchEvent('wheel', { deltaY: -1 });
  await page.waitForTimeout(100);
  const scrollTop = await scroller.evaluate(element => element.scrollTop);
  const cdp = engine === 'chromium' ? await context.newCDPSession(page) : null;
  if (cdp) await cdp.send('Performance.enable');
  const taskTime = async () => cdp ? (await cdp.send('Performance.getMetrics')).metrics.find(value => value.name === 'TaskDuration').value : null;
  const modes = Array.from({ length: samples }, () => ['visible-only', 'all-resident']).flat();
  modes.push('all-resident-control');
  for (const mode of modes) {
    for (const [socket, threadId] of sockets) send(socket, threadId, 'status', { status: 'ready' });
    await page.waitForTimeout(500);
    await page.evaluate(() => {
      const epoch = window.__measureEpoch = (window.__measureEpoch ?? 0) + 1;
      window.__measureFrames = [];
      let last = performance.now();
      const frame = now => {
        if (window.__measureEpoch !== epoch) return;
        window.__measureFrames.push(now - last); last = now;
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
      window.__measureMutations = {};
      window.__measureMutationBatches = {};
      window.__measureObserver = new MutationObserver(mutations => {
        const changed = new Set();
        for (const mutation of mutations) {
          const element = (mutation.target.nodeType === 1 ? mutation.target : mutation.target.parentElement)?.closest('[data-o8-message-id]');
          if (element) {
            const id = element.getAttribute('data-o8-message-id');
            window.__measureMutations[id] = (window.__measureMutations[id] ?? 0) + 1;
            changed.add(id);
          }
        }
        // One commit can remove hundreds of old Markdown nodes. Count its
        // notification once per message when checking update cadence.
        for (const id of changed) window.__measureMutationBatches[id] = (window.__measureMutationBatches[id] ?? 0) + 1;
      });
      window.__measureObserver.observe(document.body, { childList: true, characterData: true, subtree: true });
    });
    const before = await taskTime();
    const started = performance.now();
    for (let tick = 0; tick < 200; tick++) {
      for (const [socket, threadId] of sockets) {
        const index = plan.tabs.findIndex(tab => tab.orchestratorThreadId === threadId);
        if (index < 0 || (mode === 'visible-only' && index !== 0)) continue;
        send(socket, threadId, 'output', { assistantMessageId: `orch-${index + 1}-msg-79`,
          text: tick === 0 ? histories[index][79].content : ` sequence ${tick}.`, backend: 'codex' });
      }
      if (mode === 'all-resident-control' && tick % 20 === 0) await page.evaluate(() => {
        const end = performance.now() + 100;
        while (performance.now() < end) { /* deliberate sensitivity control */ }
      });
      const delay = started + (tick + 1) * 50 - performance.now();
      if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
    }
    const after = await taskTime();
    const data = await page.evaluate(() => {
      window.__measureEpoch++;
      window.__measureObserver.disconnect();
      return { frames: window.__measureFrames.length,
        framesOver34ms: window.__measureFrames.filter(value => value > 34).length,
        maxFrameMs: Math.max(...window.__measureFrames), mutations: window.__measureMutations,
        mutationBatches: window.__measureMutationBatches,
        mountedMessages: document.querySelectorAll('[data-o8-message-id]').length };
    });
    const observedScrollTop = await scroller.evaluate(element => element.scrollTop);
    const hiddenMutations = [3, 4].map(index => data.mutationBatches[`orch-${index}-msg-79`] ?? 0);
    const backgroundBounded = mode === 'visible-only' || hiddenMutations.every(count => count > 0 && count < 30);
    receipt.observations.push({ mode, backgroundBounded, taskMs: before === null ? null : (after - before) * 1000,
      residentSubscriptions: [...sockets.values()], durationMs: performance.now() - started,
      scrollPreserved: Math.abs(observedScrollTop - scrollTop) < 2, ...data });
  }
  await activate(3);
  for (const [socket, threadId] of sockets) send(socket, threadId, 'output', {
    assistantMessageId: `orch-${plan.tabs.findIndex(tab => tab.orchestratorThreadId === threadId) + 1}-msg-79`,
    text: ' catch-up-tail', backend: 'codex',
  });
  await page.waitForTimeout(100);
  await activate(0);
  await page.waitForFunction(() => document.querySelector('[data-o8-message-id="orch-1-msg-79"]')?.textContent.includes('catch-up-tail'));
  receipt.returnScrollPreserved = Math.abs(await scroller.evaluate(element => element.scrollTop) - scrollTop) < 2;
  receipt.controlDetected = receipt.observations.at(-1).framesOver34ms > 0;
  receipt.passed = receipt.errors.length === 0 && receipt.controlDetected && receipt.returnScrollPreserved
    && receipt.observations.every(row => row.scrollPreserved && row.mountedMessages === 240 && row.residentSubscriptions.length === 3 && (row.mutationBatches['orch-1-msg-79'] ?? 0) > 100
      && (!expectThrottle || row.backgroundBounded));
  if (!receipt.passed) process.exitCode = 1;
} catch (error) {
  receipt.error = String(error); process.exitCode = 1;
} finally {
  if (measured) receipt.browserCleanup = await closeMeasuredBrowser(measured);
  else if (browser) await browser.close();
  if (stack) await stack.close();
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify({ label, engine, passed: receipt.passed, observations: receipt.observations,
    returnScrollPreserved: receipt.returnScrollPreserved, error: receipt.error }));
}
