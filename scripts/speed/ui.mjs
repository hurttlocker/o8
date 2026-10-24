import { WebSocketServer } from 'ws';
import { chromium } from 'playwright-core';
import { resolveBrowserPath } from '../bench/measure-browser-boot.mjs';
import { instrumentationInitScript, observeComposerKeystroke } from '../bench/interactions/page-instrumentation.mjs';
import { distribution, freePort, round, sleep } from './common.mjs';

export function probeInit() {
  const probe = window.__speed = { frames: [], longTasks: [], inputs: [], last: null, sample: false };
  try { new PerformanceObserver(list => { if (probe.sample) probe.longTasks.push(...list.getEntries().map(e => e.duration)); }).observe({ type: 'longtask', buffered: false }); } catch { /* WebKit has no Long Tasks API */ }
  const frame = now => {
    if (probe.sample && probe.last !== null) probe.frames.push(now - probe.last);
    probe.last = now;
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}
export function historiesFor(keys, entries = 300) {
  return keys.map((_, session) => Array.from({ length: entries }, (_, i) => ({
    id: `speed-${session}-message-${i}`, role: i % 2 ? 'assistant' : 'user', timestamp: 1700000000000 + i * 1000,
    text: i % 2 ? `Response ${i}.\n\n${'A bounded transcript measures markdown, layout, and delivery. '.repeat(4)}\n\n\`\`\`typescript\nconst sequence = ${i};\n\`\`\`` : `Request ${i}: preserve input and scroll position.`,
  })));
}
export async function openBrowser(stack, seeded) {
  const browserPath = resolveBrowserPath();
  if (!browserPath) throw new Error('An existing Chromium browser is required; no browser is installed by this harness.');
  const browser = await chromium.launch({ executablePath: browserPath, headless: true,
    args: ['--disable-background-networking', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'] });
  let server;
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, extraHTTPHeaders: { Authorization: `Bearer ${stack.token}` } });
    const histories = historiesFor(seeded.keys);
    const latest = histories.map(entries => [...entries]);
    const sockets = new Map();
    let sequence = 0;
    let activeSessions = seeded.keys.length;
    let sentEvents = 0;
    let sentBytes = 0;
    const event = index => ({ stream: `session:${seeded.keys[index]}`, seq: ++sequence, channel: 'history', event: 'history.snapshot', data: { sessionKey: seeded.keys[index], entries: latest[index], replace: true } });
    const send = (socket, events) => {
      if (!events.length) return;
      const value = JSON.stringify({ channel: 'realtime', event: 'batch', data: { events } });
      sentBytes += Buffer.byteLength(value); sentEvents += events.length;
      socket.send(value);
    };
    await context.route('**/api/runtime/archive?**', route => route.fulfill({ json: { states: Object.fromEntries(seeded.keys.map(key => [key, 'active'])) } }));
    await context.route('**/api/runtime/inventory**', route => route.fulfill({ json: { agents: seeded.keys.map(key => ({ sessionKey: key, runtime: 'codex', status: 'running', runtimeSurface: { id: key, capabilities: { sendInput: true } } })) } }));
    await context.route('**/api/mobile/history?**', route => {
      const index = seeded.keys.indexOf(new URL(route.request().url()).searchParams.get('sessionKey'));
      return route.fulfill({ json: { transcript: latest[index] ?? [] } });
    });
    // A native loopback socket keeps fixture injection commands out of renderer timings.
    server = new WebSocketServer({ host: '127.0.0.1', port: await freePort() });
    await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
    server.on('connection', socket => {
      sockets.set(socket, new Set());
      socket.on('close', () => sockets.delete(socket));
      socket.on('message', raw => {
        const message = JSON.parse(String(raw));
        if (message.type === 'ping') socket.send(JSON.stringify({ channel: 'pong', event: 'pong' }));
        if (message.type === 'realtime-subscribe') {
          const selected = new Set((message.subscriptions ?? []).map(value => value.stream));
          sockets.set(socket, selected);
          send(socket, seeded.keys.flatMap((key, index) => selected.has(`session:${key}`) ? [event(index)] : []));
        }
      });
      socket.send(JSON.stringify({ channel: 'system', event: 'connected', data: { bootId: 'speed-fixture' } }));
    });
    // Use the dashboard's existing runtime port resolver for the owned fixture.
    await context.addInitScript(port => Object.defineProperty(window, '__O8_WS_PORT__', { get: () => port, set: () => {}, configurable: true }), server.address().port);
    await context.addInitScript(instrumentationInitScript, { selectedRepoId: seeded.repoNames[0] });
    await context.addInitScript(probeInit);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const started = performance.now();
    await page.goto(`${stack.base}/dashboard`, { waitUntil: 'domcontentloaded', timeout: 180000 });
    await page.waitForFunction(() => document.documentElement.getAttribute('data-o8-dashboard-hydrated') === '1', null, { timeout: 180000 });
    const composer = page.locator('textarea[data-o8-active-composer="true"]');
    await composer.waitFor({ state: 'visible', timeout: 60000 });
    await composer.fill('baseline');
    const interactiveMs = round(performance.now() - started);
    await page.locator('[data-o8-message-id="speed-0-message-299"]').waitFor({ state: 'attached', timeout: 30000 });
    for (const tab of [...seeded.tabs.slice(1), seeded.tabs[0]]) {
      await page.locator(`[data-o8-workspace-tab="${tab.id}"]`).first().click();
      await page.waitForTimeout(250);
    }
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const paints = await page.evaluate(() => performance.getEntriesByType('paint').map(e => ({ name: e.name, ms: e.startTime })));
    const cdp = await context.newCDPSession(page);
    await cdp.send('Performance.enable');
    const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
    let tick = 0;
    const inputFailures = [];
    const advance = () => {
      tick++;
      for (let i = 0; i < activeSessions; i++) latest[i] = [...histories[i].slice(0, -1), { ...histories[i].at(-1), text: histories[i].at(-1).text + `\nStreaming sample ${tick}.` }];
      for (const [socket, selected] of sockets) send(socket, seeded.keys.flatMap((key, i) => i < activeSessions && selected.has(`session:${key}`) ? [event(i)] : []));
    };
    const key = async () => {
      await composer.focus();
      await page.evaluate(() => { window.__speedKeyReady = false; });
      const pending = page.evaluate(`(() => {
        const observation = (${observeComposerKeystroke.toString()})('textarea[data-o8-active-composer="true"]');
        window.__speedKeyReady = true;
        return observation;
      })()`);
      // A fixed sleep can send the key before the observer is installed on a
      // loaded renderer. Wait for its explicit acknowledgement instead.
      await page.waitForFunction(() => window.__speedKeyReady === true, null, { timeout: 5000, polling: 10 });
      await page.keyboard.press('x');
      const result = await pending;
      if (result.durationMs === null) {
        const diagnostic = await page.evaluate(() => ({ activeTag: document.activeElement?.tagName,
          activeComposer: document.activeElement?.matches('textarea[data-o8-active-composer="true"]'),
          composerCount: document.querySelectorAll('textarea[data-o8-active-composer="true"]').length,
          activeTab: window.__o8Interactions?.activeTabId ?? null }));
        inputFailures.push({ note: result.note, lowerBoundMs: 5000, diagnostic, phases: result.phases });
        return 5000;
      }
      return result.durationMs;
    };
    const measure = async (sessions, durationMs = 8000) => {
      activeSessions = sessions;
      const before = await metrics();
      const counts = { sentEvents, sentBytes };
      const failuresBefore = inputFailures.length;
      await page.evaluate(() => { window.__speed.frames = []; window.__speed.longTasks = []; window.__speed.sample = true; });
      const timer = setInterval(advance, 50);
      const started = performance.now();
      const keystrokes = [];
      try { while (performance.now() - started < durationMs) { keystrokes.push(await key()); await sleep(400); } }
      finally { clearInterval(timer); }
      const after = await metrics();
      const probe = await page.evaluate(() => { window.__speed.sample = false; return window.__speed; });
      const rendered = await page.locator('[data-o8-message-id]').count();
      const marker = await page.locator('[data-o8-message-id="speed-0-message-299"]').textContent();
      return { sessions, durationMs: round(performance.now() - started), framesMs: distribution(probe.frames),
        droppedFrames: probe.frames.reduce((n, ms) => n + Math.max(0, Math.round(ms / (1000 / 60)) - 1), 0),
        longTasksMs: distribution(probe.longTasks), keystrokeMs: distribution(keystrokes), renderedMessages: rendered,
        taskMs: round((after.TaskDuration - before.TaskDuration) * 1000), scriptMs: round((after.ScriptDuration - before.ScriptDuration) * 1000),
        layoutMs: round((after.LayoutDuration - before.LayoutDuration) * 1000),
        recalcStyleMs: round((after.RecalcStyleDuration - before.RecalcStyleDuration) * 1000),
        devtoolsMs: round((after.DevToolsCommandDuration - before.DevToolsCommandDuration) * 1000), sentEvents: sentEvents - counts.sentEvents,
        sentBytes: sentBytes - counts.sentBytes, visibleTranscriptAdvanced: marker.includes('Streaming sample'),
        inputFailures: inputFailures.slice(failuresBefore),
        subscribedSessions: seeded.keys.filter(key => [...sockets.values()].some(selected => selected.has(`session:${key}`))).length };
    };
    return { browser, context, page, composer, metrics, key, advance,
      setSessions: count => { activeSessions = count; }, measure, errors, boot: { interactiveMs, paints },
      close: async () => {
        await browser.close();
        for (const socket of server.clients) socket.terminate();
        await new Promise(resolve => server.close(resolve));
      } };
  } catch (error) {
    await browser.close().catch(() => {});
    if (server) {
      for (const socket of server.clients) socket.terminate();
      await new Promise(resolve => server.close(() => resolve()));
    }
    throw error;
  }
}
