#!/usr/bin/env node
// Focused Activity scenario in the existing interaction harness. The provider
// histories and GitHub read responses are simulated; the dashboard, shared WS
// receiver, transcript store, Activity pane and browser input are production.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveBrowserPath, targetFromPanelStatus } from '../measure-browser-boot.mjs';
import { startIsolatedStack } from '../terminal-workload/runtime.mjs';
import { buildFixturePlan, materializeFixture } from './fixtures.mjs';
import { launchMeasuredBrowser, closeMeasuredBrowser } from './browser-runtime.mjs';
import { instrumentationInitScript } from './page-instrumentation.mjs';
import { distribution } from './statistics.mjs';
import { hostProfile, contentionSnapshot } from './receipt.mjs';

const option = (name, fallback) => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const output = path.resolve(option('output', 'tests/bench/latest/activity-stream-refresh.json'));
const label = option('label', 'observation');
const ticks = Number(option('ticks', '12'));
const samples = Number(option('samples', '3'));
const negativeControl = process.argv.includes('--negative-control');
if (!Number.isInteger(ticks) || ticks < 2 || ticks > 60 || !Number.isInteger(samples) || samples < 1 || samples > 10) throw new Error('Use 2-60 ticks and 1-10 samples.');
if (!fs.existsSync('.next/BUILD_ID')) throw new Error('A production build is required; development timing is not comparable.');
fs.mkdirSync(path.dirname(output), { recursive: true });
const runTag = `o8-activity-stream-${process.pid}`;
const plan = buildFixturePlan(1, 3460);
const keys = Array.from({ length: 4 }, (_, index) => `codex-owned:activity-fixture-${index + 1}`);
const histories = keys.map((_, session) => Array.from({ length: 80 }, (_, index) => ({
  id: `activity-fixture-${session + 1}-message-${index}`,
  role: index % 2 ? 'assistant' : 'user',
  timestamp: 1700000000000 + index * 1000,
  text: index % 2
    ? `Session ${session + 1} response ${index}.\n\nPreserve the original input and verify recovery.\n\n\`\`\`typescript\nconst result = { completed: true, sequence: ${index} };\n\`\`\`\n`
    : `Session ${session + 1} request ${index}: retain the selected folder and the draft.`,
})));
plan.tabs = keys.map((key, index) => ({ id: `activity-chat-${index + 1}`, label: `Activity session ${index + 1}`, kind: 'chat', chatRuntime: 'codex', chatSessionKey: key }));
const fixture = materializeFixture(plan);
const registryFile = path.join(fixture.dataDir, 'repos.json');
const registry = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
registry.repos[0].remoteUrl = 'https://github.com/example/widgets';
fs.writeFileSync(registryFile, JSON.stringify(registry));
const stateFile = path.join(fixture.dataDir, 'terminal-states/tile-root.json');
const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
state.activeTabId = plan.tabs[0].id;
state.tabs.forEach((tab, index) => Object.assign(tab, plan.tabs[index]));
fs.writeFileSync(stateFile, JSON.stringify(state));

const receipt = {
  schema: 'o8/interaction-activity-stream/v1', label,
  benchmarkHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  buildId: fs.readFileSync('.next/BUILD_ID', 'utf8').trim(), buildMode: 'production',
  host: hostProfile(), contention: contentionSnapshot(),
  workload: { seed: 3460, sessionKeys: keys, entriesPerSession: 80, cadenceMs: 1000, ticks, samples, simulated: true, payloadBytes: Buffer.byteLength(JSON.stringify(histories)) },
  primaryMetric: 'browser-initiated GitHub list reads triggered by history-only batches',
  threshold: { additionalListReads: 0 }, negativeControl, observations: [],
  limits: 'Read responses and provider output are simulated. No live model, token, GitHub quota, CPU/RAM saving, installed-native or release result is established.',
};
let stack;
let measured;
const sockets = new Set();
const subscriptions = new Map();
const wire = [];
const requests = [];
const latest = histories.map(entries => [...entries]);
const listKinds = ['prs', 'issues', 'ci', 'commits'];
let sequence = 0;
let connectionCount = 0;
let revision = 1;
const sendBatch = (socket, events) => socket.send(JSON.stringify({ channel: 'realtime', event: 'batch', data: { events } }));
const historyEvent = index => ({ stream: `session:${keys[index]}`, seq: ++sequence, channel: 'history', event: 'history.snapshot', data: { sessionKey: keys[index], entries: latest[index], replace: true } });
const reviewEvent = () => ({ stream: 'global', seq: ++sequence, channel: 'review', event: 'review.snapshot', data: { review: null, error: null } });
const counts = () => Object.fromEntries(listKinds.map(kind => [kind, requests.filter(row => row.kind === kind).length]));
const delta = (before, after) => Object.fromEntries(listKinds.map(kind => [kind, after[kind] - before[kind]]));
try {
  stack = await startIsolatedStack(process.cwd(), fixture, 'production', { runTag });
  if (stack.buildMode !== 'production') throw new Error('The measured stack is not production.');
  const statusResponse = await fetch(`http://127.0.0.1:${stack.apiPort}/api/panel/status`, { headers: { Authorization: `Bearer ${stack.token}` } });
  receipt.target = targetFromPanelStatus(await statusResponse.json());
  measured = await launchMeasuredBrowser(option('browser', null) ?? resolveBrowserPath(), runTag);
  receipt.browserVersion = measured.browser.version();
  const context = await measured.browser.newContext({ viewport: { width: 1440, height: 900 }, extraHTTPHeaders: { Authorization: `Bearer ${stack.token}` } });
  await context.route('**/api/runtime/archive?**', route => route.fulfill({ json: { states: Object.fromEntries(keys.map(key => [key, 'active'])) } }));
  await context.route('**/api/runtime/inventory**', route => route.fulfill({ json: { agents: keys.map(key => ({ sessionKey: key, runtime: 'codex', status: 'running', runtimeSurface: { id: key, capabilities: { sendInput: true } } })) } }));
  await context.route('**/api/mobile/history?**', route => {
    const key = new URL(route.request().url()).searchParams.get('sessionKey');
    return route.fulfill({ json: { transcript: latest[keys.indexOf(key)] ?? [] } });
  });
  for (const kind of listKinds) await context.route(`**/api/panel/${kind}?**`, route => {
    requests.push({ at: Date.now(), kind, url: route.request().url(), revision });
    const json = kind === 'prs'
      ? { repo: 'example/widgets', prs: [{ number: 7, title: `Retain input revision ${revision}`, state: 'OPEN', headRefName: 'fix/recovery', baseRefName: 'main', reviewDecision: 'REVIEW_REQUIRED', createdAt: '2026-10-20T10:00:00Z', updatedAt: '2026-10-20T10:00:00Z' }] }
      : kind === 'commits' ? { commits: [{ hash: 'abcd123', message: 'Retain input', date: '2026-10-20T10:00:00Z' }] }
      : kind === 'issues' ? { issues: [] } : { runs: [] };
    return route.fulfill({ json: { ...json, error: null, stale: false } });
  });
  await context.routeWebSocket('**/*', socket => {
    connectionCount++;
    sockets.add(socket);
    socket.onClose(() => { sockets.delete(socket); subscriptions.delete(socket); });
    socket.onMessage(raw => {
      const message = JSON.parse(String(raw));
      wire.push({ at: Date.now(), message });
      if (message.type === 'ping') socket.send(JSON.stringify({ channel: 'pong', event: 'pong' }));
      if (message.type !== 'realtime-subscribe') return;
      const selected = new Set((message.subscriptions ?? []).map(value => value.stream));
      subscriptions.set(socket, selected);
      const events = keys.flatMap((key, index) => selected.has(`session:${key}`) ? [historyEvent(index)] : []);
      if (connectionCount > 1 && selected.has('global')) events.push(reviewEvent());
      if (events.length) sendBatch(socket, events);
    });
    setTimeout(() => socket.send(JSON.stringify({ channel: 'system', event: 'connected', data: { bootId: 'activity-fixture' } })), 50);
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.addInitScript(instrumentationInitScript, { selectedRepoId: plan.repos[0].name });
  if (negativeControl) await page.addInitScript(() => {
    window.addEventListener('o8:realtime', event => {
      const events = event.detail?.data?.events;
      if (!Array.isArray(events) || !events.length || !events.every(entry => entry?.event === 'history.snapshot')) return;
      // Reversible negative control: reintroduce the obsolete invalidation's
      // four list reads, through the same measured fetch boundary.
      for (const kind of ['prs', 'issues', 'ci', 'commits']) void fetch(`/api/panel/${kind}?repo=example%2Fwidgets`);
    });
  });
  await page.goto(`http://127.0.0.1:${stack.apiPort}/dashboard`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction(() => document.documentElement.getAttribute('data-o8-dashboard-hydrated') === '1', null, { timeout: 90000 });
  await page.locator('[data-o8-message-id="activity-fixture-1-message-79"]').waitFor();
  await page.getByRole('button', { name: 'Open O8 panel', exact: true }).click();
  await page.getByRole('button', { name: 'Open right panel tab picker', exact: true }).click();
  await page.getByText('More tools and diagnostics', { exact: true }).click();
  await page.getByText('Activity', { exact: true }).click();
  await page.getByText('#7 Retain input revision 1', { exact: true }).waitFor();
  const composer = page.locator('textarea[data-o8-active-composer="true"]');
  const draft = 'Keep this exact unsent draft across the stream and reconnect.';
  await composer.fill(draft);
  const initialMessageIds = await page.locator('[data-o8-message-id]').evaluateAll(elements => elements.map(element => element.getAttribute('data-o8-message-id')).sort());
  const initialRequests = counts();
  for (let sample = 0; sample < samples; sample++) {
    const before = counts();
    const started = performance.now();
    for (let tick = 1; tick <= ticks; tick++) {
      const remaining = started + tick * 1000 - performance.now();
      if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining));
      for (const index of keys.keys()) latest[index] = [...histories[index].slice(0, -1), {
        ...histories[index].at(-1), text: `${histories[index].at(-1).text}\nSample ${sample + 1}, streaming sequence ${tick}.`,
      }];
      for (const socket of sockets) {
        const events = keys.flatMap((key, index) => subscriptions.get(socket)?.has(`session:${key}`) ? [historyEvent(index)] : []);
        if (events.length) sendBatch(socket, events);
      }
    }
    await page.waitForFunction(marker => document.querySelector('[data-o8-message-id="activity-fixture-1-message-79"]')?.textContent.includes(marker), `Sample ${sample + 1}, streaming sequence ${ticks}.`);
    // Drain the asynchronous refresh path before closing its count boundary.
    await page.waitForTimeout(500);
    const reads = delta(before, counts());
    const messageIds = await page.locator('[data-o8-message-id]').evaluateAll(elements => elements.map(element => element.getAttribute('data-o8-message-id')).sort());
    receipt.observations.push({ sample: sample + 1, cache: sample ? 'warm' : 'first-stream-window', durationMs: performance.now() - started, requests: reads, additionalListReads: Object.values(reads).reduce((sum, count) => sum + count, 0), draftPreserved: await composer.inputValue() === draft, mountedMessages: messageIds.length, messageIdsPreserved: JSON.stringify(messageIds) === JSON.stringify(initialMessageIds) });
  }
  const beforeReview = counts();
  revision = 2;
  for (const socket of sockets) sendBatch(socket, [historyEvent(0), reviewEvent()]);
  await page.getByText('#7 Retain input revision 2', { exact: true }).waitFor();
  const mixedBatchReads = delta(beforeReview, counts());
  const connectionsBefore = connectionCount;
  revision = 3;
  for (const socket of [...sockets]) socket.close();
  await page.getByText('#7 Retain input revision 3', { exact: true }).waitFor();
  const beforeRecoveryHistory = counts();
  const recoveryMarker = 'Post-reconnect transcript delivery.';
  latest[0] = [...latest[0].slice(0, -1), { ...latest[0].at(-1), text: `${latest[0].at(-1).text}\n${recoveryMarker}` }];
  for (const socket of sockets) {
    if (subscriptions.get(socket)?.has(`session:${keys[0]}`)) sendBatch(socket, [historyEvent(0)]);
  }
  await page.waitForFunction(marker => document.querySelector('[data-o8-message-id="activity-fixture-1-message-79"]')?.textContent.includes(marker), recoveryMarker);
  await page.waitForTimeout(500);
  const recoveredMessageIds = await page.locator('[data-o8-message-id]').evaluateAll(elements => elements.map(element => element.getAttribute('data-o8-message-id')).sort());
  receipt.recovery = { transcriptAdvanced: true, messageIdsPreserved: JSON.stringify(recoveredMessageIds) === JSON.stringify(initialMessageIds), historyOnlyReads: delta(beforeRecoveryHistory, counts()) };
  receipt.guardrails = { initialRequests, mixedBatchReads, reconnectOpenedNewTransport: connectionCount > connectionsBefore, recoveredFeed: true, draftPreserved: await composer.inputValue() === draft, subscribedSession: [...subscriptions.values()].some(selected => selected.has(`session:${keys[0]}`)), pageErrors: errors };
  receipt.requests = requests;
  receipt.wire = wire;
  receipt.additionalListReads = distribution(receipt.observations.map(row => row.additionalListReads));
  receipt.passed = receipt.observations.every(row => row.additionalListReads === 0 && row.draftPreserved && row.messageIdsPreserved && row.mountedMessages === 240) && Object.values(mixedBatchReads).every(count => count >= 1) && Object.values(receipt.guardrails).every(value => value !== false) && errors.length === 0 && receipt.recovery.transcriptAdvanced && receipt.recovery.messageIdsPreserved && Object.values(receipt.recovery.historyOnlyReads).every(count => count === 0);
  await page.screenshot({ path: `${output}.png` });
} catch (error) {
  receipt.error = String(error);
  receipt.passed = false;
} finally {
  if (measured) {
    receipt.cleanup = await closeMeasuredBrowser(measured);
    if (receipt.cleanup.closeTimedOut || receipt.cleanup.survivors.length || receipt.cleanup.snapshotErrors.length) receipt.passed = false;
  }
  if (stack) await stack.close();
  else fs.rmSync(fixture.dataDir, { recursive: true, force: true });
  fs.writeFileSync(output, JSON.stringify(receipt, null, 2));
}
console.log('[activity-stream-refresh]', JSON.stringify({ label, passed: receipt.passed, observations: receipt.observations, guardrails: receipt.guardrails, recovery: receipt.recovery, error: receipt.error ?? null }));
if (!receipt.passed) process.exitCode = 1;
