// Production dashboard receipt. Build with npm run build before invoking this.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { fixture } from '../speed/stack.mjs';
import { historiesFor } from '../speed/ui.mjs';
import { nativeFixture } from '../speed/native-fixture.mjs';
import { freePort, launch, stop } from '../speed/common.mjs';
import { instrumentationInitScript } from './interactions/page-instrumentation.mjs';
import { resolveBrowserPath } from './measure-browser-boot.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const round = value => Math.round(value * 100) / 100;

async function launchBrowser() {
  return chromium.launch({ executablePath: resolveBrowserPath(), headless: true,
    args: ['--no-sandbox', '--disable-background-networking',
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding'] });
}

export async function measureDashboardStartup({ samples = 3, evidenceDir, buildDir = path.join(root, '.next'), browser: existingBrowser, profile = false }) {
  fs.mkdirSync(evidenceDir, { recursive: true });
  const serverRoot = path.join(buildDir, 'standalone');
  assert.ok(fs.existsSync(path.join(serverRoot, 'server.js')), 'Build the standalone server first');
  // These are the same static resources copied into the release server export.
  fs.cpSync(path.join(buildDir, 'static'), path.join(serverRoot, '.next/static'), { recursive: true });
  fs.cpSync(path.join(root, 'public'), path.join(serverRoot, 'public'), { recursive: true });
  const browser = existingBrowser ?? await launchBrowser();
  const browserVersion = browser.version();
  const results = [];
  try {
    for (let sample = 0; sample < samples; sample++) {
      const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'o8-dashboard-startup-'));
      const seeded = fixture(parent);
      nativeFixture(seeded);
      const token = randomBytes(32).toString('hex');
      fs.writeFileSync(path.join(seeded.dataDir, 'ws-token'), token, { mode: 0o600 });
      const apiPort = await freePort();
      let wsPort = await freePort();
      while (wsPort === apiPort) wsPort = await freePort();
      const renderReceipt = path.join(parent, 'render.jsonl');
      const observer = path.join(parent, 'render.cjs');
      // Observe the real HTTP listener, including cold route import and SSR.
      fs.writeFileSync(observer, `
        const { appendFileSync } = require('node:fs');
        const { Server } = require('node:http');
        const NextServer = require(${JSON.stringify(path.join(serverRoot, 'node_modules/next/dist/server/next-server.js'))}).default;
        const render = NextServer.prototype.renderToResponseWithComponents;
        NextServer.prototype.renderToResponseWithComponents = async function (context, ...args) {
          const start = performance.now();
          try { return await render.call(this, context, ...args); }
          finally {
            if (context.pathname === '/dashboard') appendFileSync(${JSON.stringify(renderReceipt)},
              JSON.stringify({ renderMs: performance.now() - start }) + '\\n');
          }
        };
        const emit = Server.prototype.emit;
        Server.prototype.emit = function (event, req, res, ...args) {
          if (event === 'request' && req.url === '/dashboard') {
            const start = performance.now();
            res.once('finish', () => appendFileSync(${JSON.stringify(renderReceipt)},
              JSON.stringify({ serverMs: performance.now() - start }) + '\\n'));
          }
          return emit.call(this, event, req, res, ...args);
        };
      `);
      const env = { ...process.env, NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1',
        HOSTNAME: '127.0.0.1', PORT: String(apiPort), O8_API_PORT: String(apiPort), O8_WS_PORT: String(wsPort),
        O8_DATA_DIR: seeded.dataDir, CORTEX_IDE_DATA_DIR: seeded.dataDir,
        CORTEX_IDE_REPO_ROOT: seeded.repoDir, CORTEX_IDE_REVIEW_REPO_ROOT: seeded.repoDir };
      for (const key of ['NODE_OPTIONS', '__NEXT_PRIVATE_STANDALONE_CONFIG', 'CORTEX_IDE_DB_PATH',
        'WS_TOKEN', 'O8_PACKAGED_APP', 'O8_BOOT_ID', 'O8_INSTANCE_ID']) delete env[key];
      const server = launch(['--require', observer, path.join(serverRoot, 'server.js')], env,
        path.join(evidenceDir, `server-${sample + 1}.log`), process.execPath, serverRoot);
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 },
        extraHTTPHeaders: { Authorization: `Bearer ${token}` } });
      try {
        const base = `http://127.0.0.1:${apiPort}`;
        // Readiness does not request a page or warm the dashboard route.
        let ready = false;
        for (let attempt = 0; attempt < 400; attempt++) {
          try { ready = (await fetch(`${base}/api/panel/status`, {
            headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(2_000),
          })).ok; }
          catch { /* listener is starting */ }
          if (ready) break;
          if (server.child.exitCode !== null) throw new Error('Standalone server exited before readiness');
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        assert.ok(ready, 'Standalone listener ready');
        // Use the same bounded provider inventory/history transport as speed/ui.
        // Tab persistence and repository/layout endpoints remain the real server.
        const histories = historiesFor(seeded.keys);
        await context.route('**/api/runtime/archive?**', route => route.fulfill({
          json: { states: Object.fromEntries(seeded.keys.map(key => [key, 'active'])) },
        }));
        await context.route('**/api/runtime/inventory**', route => route.fulfill({ json: {
          agents: seeded.keys.map(key => ({ sessionKey: key, runtime: 'codex', status: 'running',
            runtimeSurface: { id: key, capabilities: { sendInput: true } } })),
        } }));
        await context.route('**/api/mobile/history?**', route => {
          const index = seeded.keys.indexOf(new URL(route.request().url()).searchParams.get('sessionKey'));
          return route.fulfill({ json: { transcript: histories[index] ?? [] } });
        });
        await context.routeWebSocket('**/*', socket => {
          socket.onMessage(raw => {
            const message = JSON.parse(String(raw));
            if (message.type === 'ping') socket.send(JSON.stringify({ channel: 'pong', event: 'pong' }));
          });
          socket.send(JSON.stringify({ channel: 'system', event: 'connected', data: { bootId: 'fixture' } }));
        });
        await context.addInitScript(instrumentationInitScript, { selectedRepoId: seeded.repoNames[0] });
        await context.addInitScript(() => {
          const commits = [];
          window.__dashboardCommits = commits;
          const containsWorkspace = fiber => {
            for (let node = fiber; node; node = node.sibling) {
              if (node.stateNode instanceof HTMLElement && node.stateNode.hasAttribute('data-o8-workspace')) return true;
              if (node.child && containsWorkspace(node.child)) return true;
            }
            return false;
          };
          window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
            supportsFiber: true, inject: () => 1,
            onCommitFiberRoot: (_renderer, committedRoot) => {
              if (commits.length === 0 && containsWorkspace(committedRoot.current)) commits.push(performance.now());
            },
            onCommitFiberUnmount: () => {},
          };
        });
        const page = await context.newPage();
        // The native phase definitions start document timing after the webview
        // exists. Initialize only a blank renderer; load no application assets.
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const profiler = profile ? await context.newCDPSession(page) : null;
        if (profiler) { await profiler.send('Profiler.enable'); await profiler.send('Profiler.start'); }
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        const response = await page.goto(`${base}/dashboard`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        assert.equal(response.status(), 200);
        const htmlBytes = (await response.body()).length;
        await page.waitForFunction(() => document.documentElement.getAttribute('data-o8-dashboard-hydrated') === '1',
          null, { timeout: 60_000 });
        if (profiler) {
          const { profile: cpu } = await profiler.send('Profiler.stop');
          fs.writeFileSync(path.join(evidenceDir, `cpu-${sample + 1}.json`), JSON.stringify(cpu));
        }
        const timing = await page.evaluate(() => {
          const nav = performance.getEntriesByType('navigation')[0];
          const hydrated = window.__o8Interactions.hydratedAtMs;
          return {
            documentMs: nav.responseEnd - nav.startTime,
            ttfbMs: nav.responseStart - nav.requestStart,
            hydrationMs: hydrated - nav.responseEnd,
            commitMs: window.__dashboardCommits[0] - nav.responseEnd,
            longTasks: window.__o8Interactions.longTasks.filter(task => task.startTime < hydrated),
            chunks: performance.getEntriesByType('resource')
              .filter(entry => entry.name.includes('/_next/') && new URL(entry.name).pathname.endsWith('.js') && entry.startTime <= hydrated)
              .map(entry => ({ chunk: new URL(entry.name).pathname.split('/').pop(),
                bytes: entry.decodedBodySize, encodedBytes: entry.encodedBodySize })),
          };
        });
        fs.writeFileSync(path.join(evidenceDir, `timing-${sample + 1}.json`), JSON.stringify({ htmlBytes, ...timing }));
        assert.deepEqual(errors, [], 'No dashboard mount errors');
        const tabs = page.locator('[data-o8-workspace-tab]');
        await tabs.first().waitFor({ timeout: 30_000 });
        const restoredTabIds = await tabs.evaluateAll(nodes => [...new Set(nodes.map(node => node.getAttribute('data-o8-workspace-tab')))]);
        for (const tab of seeded.tabs) assert.ok(restoredTabIds.includes(tab.id), `Restored ${tab.id}`);
        for (const tab of [seeded.tabs[1], seeded.tabs[0]]) {
          await page.locator(`[data-o8-workspace-tab="${tab.id}"]`).first().click({ timeout: 15_000 });
          await page.waitForFunction(id => window.__o8Interactions.activeTabId === id, tab.id);
        }
        const composer = page.locator('textarea[data-o8-active-composer="true"]');
        const frameGeometry = () => page.evaluate(() => [...document.querySelectorAll('[data-slot="smooth-corners"]')]
          .map(node => {
            const box = node.getBoundingClientRect();
            return { x: box.x, y: box.y, width: box.width, height: box.height,
              ready: node.getAttribute('data-state'), clip: node.style.clipPath };
          }).filter(box => box.width > 0 && box.height > 0));
        const originalFrames = await frameGeometry();
        assert.ok(originalFrames.length > 0 && originalFrames.every(frame => frame.ready === 'ready' && frame.clip), 'Visible frames are clipped');
        await composer.fill('Unsent startup fixture');
        await page.getByRole('button', { name: 'More navigation', exact: true }).click();
        await page.getByRole('menuitem', { name: 'Projects', exact: true }).click();
        await page.getByRole('main', { name: 'Projects', exact: true }).waitFor({ state: 'visible' });
        await page.getByRole('button', { name: 'Back to workspace', exact: true }).click();
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        assert.deepEqual(await frameGeometry(), originalFrames, 'Frame geometry survives the Projects round trip');
        assert.equal(await composer.inputValue(), 'Unsent startup fixture', 'Projects preserves the workspace draft');
        await composer.fill('');
        assert.equal(await composer.inputValue(), '');
        const serverTiming = Object.assign({}, ...fs.readFileSync(renderReceipt, 'utf8').trim().split('\n').map(line => JSON.parse(line)));
        assert.ok(Number.isFinite(serverTiming.renderMs), 'Observed the real Next dashboard render');
        assert.ok(Number.isFinite(timing.commitMs), 'Observed the React workspace commit');
        const result = { sample: sample + 1, serverMs: round(serverTiming.serverMs), renderMs: round(serverTiming.renderMs), htmlBytes,
          ...timing, restoredTabs: seeded.tabs.length, tabSwitches: 2, projectsRoundTrip: true, frameGeometryPreserved: true, draftCleared: true };
        for (const key of ['documentMs', 'ttfbMs', 'hydrationMs', 'commitMs']) result[key] = round(result[key]);
        results.push(result);
      } finally {
        await context.close();
        await stop(server);
        fs.rmSync(parent, { recursive: true, force: true });
      }
    }
  } finally { if (!existingBrowser) await browser.close(); }
  return { node: process.versions.node, platform: process.platform, chromium: browserVersion, samples: results };
}

export async function compareDashboardStartup({ baselineBuildDir, evidenceDir, samples = 3 }) {
  const arms = { before: null, after: null };
  const browser = await launchBrowser();
  try {
    for (let sample = 0; sample < samples; sample++) {
      for (const arm of ['before', 'after']) {
        const receipt = await measureDashboardStartup({ samples: 1, browser,
          evidenceDir: path.join(evidenceDir, `${arm}-${sample + 1}`),
          ...(arm === 'before' ? { buildDir: baselineBuildDir } : {}),
        });
        arms[arm] ??= { ...receipt, samples: [] };
        arms[arm].samples.push({ ...receipt.samples[0], sample: sample + 1 });
      }
    }
  } finally { await browser.close(); }
  return arms;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const evidenceDir = path.resolve(process.argv[2] ?? 'work/dashboard-startup');
  const receipt = await measureDashboardStartup({ evidenceDir, samples: Number(process.argv[3] ?? 3) });
  fs.writeFileSync(path.join(evidenceDir, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify(receipt, null, 2));
}
