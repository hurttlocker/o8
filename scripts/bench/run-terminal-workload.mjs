#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { resolveBrowserPath } from './measure-browser-boot.mjs';
import { snapshotProcesses } from '../lib/footprint-budget.mjs';
import {
  cleanupTmuxSessions,
  measureProcessGroups,
  resolveProcessGroups,
  seedFixtureState,
  sleep,
  startIsolatedStack,
} from './terminal-workload/runtime.mjs';
import { connectTerminalClients } from './terminal-workload/ws-client.mjs';
import { summarizeSamples } from './terminal-workload/statistics.mjs';

const ROOT = process.cwd();

function option(name, fallback) {
  const prefix = `--${name}=`;
  const inline = process.argv.find((value) => value.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function config() {
  const sessionCounts = String(option('sessions', '1,4,12'))
    .split(',')
    .map(Number)
    .filter((value) => Number.isInteger(value) && value > 0);
  const samples = Math.max(3, Number(option('samples', 3)) || 3);
  const durationMs = Math.max(1000, Number(option('duration-ms', 10000)) || 10000);
  const bytesPerSecond = Math.max(1024, Number(option('bytes-per-second', 81920)) || 81920);
  const chunkMs = Math.max(8, Number(option('chunk-ms', 32)) || 32);
  const seed = Number(option('seed', 1721)) || 1721;
  const runId = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
  return {
    sessionCounts: sessionCounts.length > 0 ? sessionCounts : [1, 4, 12],
    samples,
    durationMs,
    bytesPerSecond,
    chunkMs,
    seed,
    requestedBuildMode: String(option('build-mode', 'auto')),
    rawDir: path.resolve(option('output-dir', path.join(ROOT, 'tests/bench/latest/terminal-workload', runId))),
    receiptPath: path.resolve(option('receipt', path.join(ROOT, 'tests/bench/results/terminal-workload-baseline.json'))),
  };
}

function round(value, digits = 2) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function gitInfo() {
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  const status = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: ROOT, encoding: 'utf8' });
  const hash = createHash('sha256').update(status);
  for (const line of status.split('\n').filter(Boolean)) {
    const relative = line.slice(3).replace(/^.* -> /, '');
    const absolute = path.join(ROOT, relative);
    if (fs.existsSync(absolute) && fs.statSync(absolute).isFile()) hash.update(fs.readFileSync(absolute));
  }
  return { commit, dirty: status.trim().length > 0, treeFingerprint: hash.digest('hex') };
}

function machineClass() {
  return {
    hardware: {
      arch: os.arch(),
      cpuModel: os.cpus()[0]?.model ?? 'unknown',
      logicalCpuCount: os.cpus().length,
      totalMemoryBytes: os.totalmem(),
    },
    os: { platform: os.platform(), release: os.release() },
  };
}

function browserInitScript() {
  window.__o8TerminalBenchEnabled = true;
  window.__o8TerminalBenchTabs = null;
  window.__o8TerminalPerf = { startedAt: performance.now(), frames: 0, longTasks: [], longTaskSupported: false };
  window.addEventListener('o8:workspace-active-label', (event) => {
    const detail = event.detail;
    if (detail?.activeWorkspaceSurface && Array.isArray(detail.tabs)) window.__o8TerminalBenchTabs = detail;
  });
  window.__o8TerminalPerf.longTaskSupported = PerformanceObserver.supportedEntryTypes?.includes('longtask') ?? false;
  if (window.__o8TerminalPerf.longTaskSupported) {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        window.__o8TerminalPerf.longTasks.push({ startTime: entry.startTime, duration: entry.duration });
      }
    });
    observer.observe({ type: 'longtask', buffered: true });
  }
  const frame = () => {
    window.__o8TerminalPerf.frames += 1;
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

async function dashboardDiagnostic(page) {
  return page.evaluate(() => {
    const workspace = document.querySelector('[data-o8-workspace]');
    const rect = workspace instanceof HTMLElement ? workspace.getBoundingClientRect() : null;
    return {
      hydrated: document.documentElement.getAttribute('data-o8-dashboard-hydrated'),
      workspaceCount: document.querySelectorAll('[data-o8-workspace]').length,
      workspaceRect: rect ? { width: rect.width, height: rect.height } : null,
      tabs: window.__o8TerminalBenchTabs?.tabs ?? null,
      activeTabId: window.__o8TerminalBenchTabs?.tabId ?? null,
      chipIds: Array.from(document.querySelectorAll('[data-o8-workspace-tab]')).map((element) => element.getAttribute('data-o8-workspace-tab')),
      panelSessions: Array.from(document.querySelectorAll('[data-o8-term-panel]')).map((element) => ({
        sessionName: element.getAttribute('data-o8-term-panel'),
        display: getComputedStyle(element).display,
      })),
      bodyText: document.body.innerText.slice(0, 1200),
    };
  });
}

async function waitForSeededDashboard(page, baseUrl, seeded) {
  const response = await page.goto(`${baseUrl}/dashboard`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  if (!response?.ok()) throw new Error(`/dashboard returned ${response?.status() ?? 'no response'}`);
  try {
    await page.waitForFunction(() => {
      const workspace = document.querySelector('[data-o8-workspace]');
      if (!(workspace instanceof HTMLElement)) return false;
      const rect = workspace.getBoundingClientRect();
      return document.documentElement.getAttribute('data-o8-dashboard-hydrated') === '1'
        && rect.width > 0 && rect.height > 0;
    }, undefined, { timeout: 90000 });
    await page.waitForFunction(({ terminalIds, activeTabId }) => {
      const tabs = window.__o8TerminalBenchTabs?.tabs;
      if (!Array.isArray(tabs)) return false;
      const terminalTabs = tabs.filter((tab) => terminalIds.includes(tab.id));
      const orchestrators = tabs.filter((tab) => tab.kind === 'orchestrator');
      const chipIds = Array.from(document.querySelectorAll('[data-o8-workspace-tab]'))
        .map((element) => element.getAttribute('data-o8-workspace-tab'));
      return terminalTabs.length === terminalIds.length
        && orchestrators.length === 1
        && chipIds.filter((id) => terminalIds.includes(id)).length === terminalIds.length
        && chipIds.filter((id) => id?.startsWith('orchestrator-')).length === 1
        && window.__o8TerminalBenchTabs.tabId === activeTabId;
    }, { terminalIds: seeded.tabs.map((tab) => tab.id), activeTabId: seeded.tabs[0].id }, { timeout: 45000 });
  } catch (error) {
    throw new Error(`seeded dashboard contract failed: ${JSON.stringify(await dashboardDiagnostic(page))}`, { cause: error });
  }
  return page.evaluate(() => ({
    activeTabId: window.__o8TerminalBenchTabs.tabId,
    workspaceId: window.__o8TerminalBenchTabs.workspaceId,
    tabs: window.__o8TerminalBenchTabs.tabs,
  }));
}

async function waitForPanelContract(page, activeSessionName) {
  const deadline = Date.now() + 45000;
  let previous = null;
  while (Date.now() < deadline) {
    const inventory = await page.evaluate((expectedVisible) => {
      const panels = Array.from(document.querySelectorAll('[data-o8-term-panel]'));
      const visible = panels.filter((panel) => getComputedStyle(panel).display !== 'none');
      return {
        valid: panels.length >= 1
          && visible.length === 1
          && visible[0]?.getAttribute('data-o8-term-panel') === expectedVisible,
        mountedTerminalPanelCount: panels.length,
        visibleTerminalPanelCount: visible.length,
        mountedSessionNames: panels.map((panel) => panel.getAttribute('data-o8-term-panel')).filter(Boolean),
      };
    }, activeSessionName);
    const signature = JSON.stringify(inventory);
    if (inventory.valid && signature === previous) {
      return {
        mountedTerminalPanelCount: inventory.mountedTerminalPanelCount,
        visibleTerminalPanelCount: inventory.visibleTerminalPanelCount,
        mountedSessionNames: inventory.mountedSessionNames,
      };
    }
    previous = inventory.valid ? signature : null;
    await sleep(350);
  }
  throw new Error(`terminal panel contract did not stabilize: ${JSON.stringify(await dashboardDiagnostic(page))}`);
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function generatorCommand(generatorPath, sessionName, runConfig, sampleSeed) {
  return [
    shellQuote(process.execPath), shellQuote(generatorPath),
    '--session', shellQuote(sessionName),
    '--bytes-per-second', String(runConfig.bytesPerSecond),
    '--duration-ms', String(runConfig.durationMs),
    '--chunk-ms', String(runConfig.chunkMs),
    '--seed', String(sampleSeed),
  ].join(' ');
}

async function fetchPtyInventory(stack) {
  const response = await fetch(`http://127.0.0.1:${stack.apiPort}/api/panel/terminal-sessions`, {
    headers: { Authorization: `Bearer ${stack.token}` },
  });
  if (!response.ok) throw new Error(`terminal session inventory returned ${response.status}`);
  const payload = await response.json();
  return Array.isArray(payload.sessions) ? payload.sessions : [];
}

async function prepareShell(client, sessionName, seed) {
  const marker = `O8_SHELL_READY_${sessionName}_${seed}`;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    client.send({
      type: 'terminal-input',
      sessionName,
      data: `\x03printf '${marker}\\n'\r`,
    });
    try {
      await client.waitForText(sessionName, marker, 5000);
      return;
    } catch (error) {
      if (attempt === 3) throw error;
    }
  }
}

async function resetPageMeasurement(page) {
  await page.evaluate(() => {
    window.__o8TerminalWriteStats?.reset();
    window.__o8TerminalPerf.startedAt = performance.now();
    window.__o8TerminalPerf.frames = 0;
    window.__o8TerminalPerf.longTasks = [];
  });
}

async function readPageStats(page) {
  return page.evaluate(() => {
    const stats = window.__o8TerminalWriteStats;
    if (!stats) throw new Error('terminal write instrumentation was not installed');
    const at = performance.now();
    const sessions = Object.fromEntries(Object.entries(stats.sessions).map(([sessionName, session]) => {
      const elapsed = Math.max(0, at - session.visibilityChangedAt);
      return [sessionName, {
        mountCount: session.mountCount,
        unmountCount: session.unmountCount,
        mounted: session.mounted,
        visible: session.visible,
        visibleMs: session.visibleMs + (session.visible ? elapsed : 0),
        hiddenMs: session.hiddenMs + (session.visible ? 0 : elapsed),
        visibleWork: { ...session.visibleWork },
        hiddenWork: { ...session.hiddenWork },
      }];
    }));
    return {
      schema: stats.schema,
      observationMs: at - stats.startedAt,
      sessions,
      transport: { ...stats.transport },
    };
  });
}

async function readPerformance(page, observationMs) {
  return page.evaluate((elapsedMs) => {
    const perf = window.__o8TerminalPerf;
    const longTaskMs = perf.longTasks.reduce((sum, task) => sum + task.duration, 0);
    return {
      longTaskSupported: perf.longTaskSupported,
      longTaskCount: perf.longTasks.length,
      longTaskMs,
      longTaskMsPerMinute: elapsedMs > 0 ? longTaskMs * 60000 / elapsedMs : null,
      frameCount: perf.frames,
      framesPerSecond: elapsedMs > 0 ? perf.frames * 1000 / elapsedMs : null,
      longTasks: perf.longTasks,
    };
  }, observationMs);
}

async function measureKeystrokeToPaint(page, sessionName, marker) {
  const input = page.locator(`[data-o8-term-panel="${sessionName}"] .xterm-helper-textarea`);
  await input.focus();
  await page.waitForFunction((expectedSession) => {
    const panel = document.querySelector(`[data-o8-term-panel="${CSS.escape(expectedSession)}"]`);
    return panel?.contains(document.activeElement) === true
      && document.activeElement?.classList.contains('xterm-helper-textarea') === true;
  }, sessionName, { timeout: 5000 });
  const startedAt = await page.evaluate(() => performance.now());
  await page.keyboard.type(marker);
  await page.keyboard.press('Enter');
  try {
    await page.waitForFunction(({ targetSession, targetMarker }) => {
      const session = window.__o8TerminalWriteStats?.sessions[targetSession];
      return session?.readText(80).includes(targetMarker) === true;
    }, { targetSession: sessionName, targetMarker: marker }, { polling: 'raf', timeout: 10000 });
    const paintedAt = await page.evaluate(() => performance.now());
    return { elapsedMs: paintedAt - startedAt, timedOut: false };
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('Timeout')) throw error;
    return { elapsedMs: 10000, timedOut: true };
  }
}

async function selectTabAndMeasure(page, tab, marker) {
  const startedAt = await page.evaluate(() => performance.now());
  await page.locator(`[data-o8-workspace-tab="${tab.id}"]`).click();
  await page.waitForFunction(({ sessionName, tabId }) => {
    const panel = document.querySelector(`[data-o8-term-panel="${CSS.escape(sessionName)}"]`);
    return panel && getComputedStyle(panel).display !== 'none' && window.__o8TerminalBenchTabs?.tabId === tabId;
  }, { sessionName: tab.sessionName, tabId: tab.id }, { polling: 'raf', timeout: 10000 });
  const visibleAt = await page.evaluate(() => performance.now());
  await page.waitForFunction(({ sessionName, markerText }) => (
    window.__o8TerminalWriteStats?.sessions[sessionName]?.readText(100).includes(markerText) === true
  ), { sessionName: tab.sessionName, markerText: marker }, { polling: 'raf', timeout: 10000 });
  const correctAt = await page.evaluate(() => performance.now());
  return { revealMs: visibleAt - startedAt, firstCorrectFrameMs: correctAt - startedAt };
}

function deriveBrowser(raw, expectedSessions, initiallyMountedSessionNames) {
  const sessions = expectedSessions.map((session) => ({ ...session, stats: raw.sessions[session.sessionName] ?? null }));
  const hiddenRates = sessions
    .filter((entry) => initiallyMountedSessionNames.includes(entry.sessionName)
      && entry.stats && entry.stats.hiddenMs > 0 && entry.stats.hiddenWork.calls > 0)
    .map((entry) => ({
      bytes: entry.stats.hiddenWork.decodedBytes / (entry.stats.hiddenMs / 1000),
      calls: entry.stats.hiddenWork.calls / (entry.stats.hiddenMs / 1000),
    }));
  const sum = (selector) => sessions.reduce((total, entry) => total + (entry.stats ? selector(entry.stats) : 0), 0);
  const initiallyUnmounted = sessions.filter((entry) => !initiallyMountedSessionNames.includes(entry.sessionName));
  const neverMounted = sessions.filter((entry) => !entry.stats || entry.stats.mountCount === 0);
  return {
    hiddenWriteBytesPerSecondPerPanel: hiddenRates.length > 0 ? round(hiddenRates.reduce((sumValue, rate) => sumValue + rate.bytes, 0) / hiddenRates.length) : 0,
    hiddenWriteCallsPerSecondPerPanel: hiddenRates.length > 0 ? round(hiddenRates.reduce((sumValue, rate) => sumValue + rate.calls, 0) / hiddenRates.length) : 0,
    totalVisibleWriteBytes: sum((stats) => stats.visibleWork.decodedBytes),
    totalHiddenWriteBytes: sum((stats) => stats.hiddenWork.decodedBytes),
    totalWriteCalls: sum((stats) => stats.visibleWork.calls + stats.hiddenWork.calls),
    totalDecodeMs: round(sum((stats) => stats.visibleWork.decodeMs + stats.hiddenWork.decodeMs)),
    totalWriteCallMs: round(sum((stats) => stats.visibleWork.writeCallMs + stats.hiddenWork.writeCallMs)),
    totalWriteCompletionMs: round(sum((stats) => stats.visibleWork.writeCompletionMs + stats.hiddenWork.writeCompletionMs)),
    totalRenderEvents: sum((stats) => stats.visibleWork.renderEvents + stats.hiddenWork.renderEvents),
    totalRenderRows: sum((stats) => stats.visibleWork.renderRows + stats.hiddenWork.renderRows),
    initiallyUnmountedSessionNames: initiallyUnmounted.map((entry) => entry.sessionName),
    neverMountedSessionNames: neverMounted.map((entry) => entry.sessionName),
    residencyChurnSessionNames: initiallyUnmounted
      .filter((entry) => entry.stats && entry.stats.mountCount > 0)
      .map((entry) => entry.sessionName),
    endMountedSessionNames: sessions.filter((entry) => entry.stats?.mounted).map((entry) => entry.sessionName),
    initiallyUnmountedWriteBytes: initiallyUnmounted.reduce((total, entry) => total + (entry.stats?.visibleWork.decodedBytes ?? 0) + (entry.stats?.hiddenWork.decodedBytes ?? 0), 0),
    unmountedWriteBytes: neverMounted.reduce((total, entry) => total + (entry.stats?.visibleWork.decodedBytes ?? 0) + (entry.stats?.hiddenWork.decodedBytes ?? 0), 0),
    transport: raw.transport,
    sessions: raw.sessions,
  };
}

function deriveServer(snapshot, expectedSessions, unmountedSessionNames) {
  const sessions = expectedSessions.map((session) => snapshot.sessions[session.sessionName]).filter(Boolean);
  const sum = (selector) => sessions.reduce((total, session) => total + selector(session), 0);
  return {
    visiblePtyChunks: sum((session) => session.pty.visible.chunks),
    visiblePtyBytes: sum((session) => session.pty.visible.bytes),
    hiddenPtyChunks: sum((session) => session.pty.hidden.chunks),
    hiddenPtyBytes: sum((session) => session.pty.hidden.bytes),
    attachEvents: sum((session) => session.attachEvents),
    detachEvents: sum((session) => session.detachEvents),
    bufferEvents: sum((session) => session.buffer.events),
    replayEvents: sum((session) => session.replay.events),
    overflowEvents: sum((session) => session.overflow.events),
    overflowBytes: sum((session) => session.overflow.bytes),
    backpressureDropEvents: sum((session) => session.backpressureDrops.events),
    backpressureDropBytes: sum((session) => session.backpressureDrops.bytes),
    fanoutClientDeliveries: sum((session) => session.fanout.clientDeliveries),
    unmountedHiddenBytes: unmountedSessionNames.reduce((total, sessionName) => total + (snapshot.sessions[sessionName]?.pty.hidden.bytes ?? 0), 0),
    sessions: snapshot.sessions,
  };
}

async function runSample({ browser, browserPid, runConfig, sessionCount, sampleIndex }) {
  const sampleSeed = runConfig.seed + sessionCount * 100 + sampleIndex;
  const runPrefix = `tw${Date.now().toString(36)}n${sessionCount}s${sampleIndex}`;
  const seeded = seedFixtureState(sessionCount, runPrefix);
  const expectedSessionNames = seeded.tabs.map((tab) => tab.sessionName);
  let stack;
  let context;
  let page;
  let clients = [];
  try {
    stack = await startIsolatedStack(ROOT, seeded, runConfig.requestedBuildMode);
    context = await browser.newContext({ viewport: { width: 1000, height: 800 } });
    page = await context.newPage();
    await page.addInitScript(browserInitScript);
    const ui = await waitForSeededDashboard(page, `http://127.0.0.1:${stack.apiPort}`, seeded);
    const panelInventory = await waitForPanelContract(page, seeded.tabs[0].sessionName);

    const wsUrl = `ws://127.0.0.1:${stack.wsPort}/ws?token=${encodeURIComponent(stack.token)}`;
    clients = await connectTerminalClients(wsUrl, sessionCount);
    await Promise.all(seeded.tabs.map((tab, index) => clients[index].createAndAttach({
      ownerKey: `workspace:${tab.id}`,
      requestId: `bench-${runPrefix}-${index + 1}`,
      sessionName: tab.sessionName,
      cwd: seeded.repoDir,
    })));
    await Promise.all(seeded.tabs.map((tab, index) => (
      prepareShell(clients[index], tab.sessionName, sampleSeed)
    )));
    await clients[0].request('terminal-bench-reset');
    await clients[0].request('terminal-bench-visibility', {
      sessions: seeded.tabs.map((tab, index) => ({ sessionName: tab.sessionName, visible: index === 0 })),
    });
    const attachmentSnapshot = (await clients[0].request('terminal-bench-stats')).data.snapshot;
    const attachedClientsPerSession = Object.fromEntries(seeded.tabs.map((tab) => [
      tab.sessionName,
      attachmentSnapshot.sessions[tab.sessionName]?.attachedClientCount ?? null,
    ]));
    const ptySessions = await fetchPtyInventory(stack);
    await resetPageMeasurement(page);

    const before = snapshotProcesses();
    const groups = resolveProcessGroups(before, stack, browserPid);
    const observationStartedAt = Date.now();
    const generatorPath = path.join(ROOT, 'scripts/bench/terminal-workload/generator.mjs');
    for (const [index, tab] of seeded.tabs.entries()) {
      clients[index].send({
        type: 'terminal-input',
        sessionName: tab.sessionName,
        data: `${generatorCommand(generatorPath, tab.sessionName, runConfig, sampleSeed)}\r`,
      });
    }
    await Promise.all(seeded.tabs.map((tab, index) => clients[index].waitForText(
      tab.sessionName,
      `O8_WORKLOAD_READY_${tab.sessionName}_${sampleSeed}`,
      30000,
    )));

    await sleep(700);
    const keystrokeToPaint = [];
    for (let index = 0; index < 3; index += 1) {
      const marker = `O8K_${sampleSeed}_${index}`;
      keystrokeToPaint.push(await measureKeystrokeToPaint(page, seeded.tabs[0].sessionName, marker));
      await sleep(100);
    }

    const revealMs = [];
    const firstCorrectFrameMs = [];
    let revealAvailability = 'not-applicable-single-terminal';
    const mountedHidden = seeded.tabs.find((tab) => (
      panelInventory.mountedSessionNames.includes(tab.sessionName) && tab.sessionName !== seeded.tabs[0].sessionName
    ));
    const revealTarget = mountedHidden ?? seeded.tabs.find((tab) => tab.sessionName !== seeded.tabs[0].sessionName);
    const revealAt = Math.floor(runConfig.durationMs * 0.55);
    const elapsedBeforeReveal = Date.now() - observationStartedAt;
    if (elapsedBeforeReveal < revealAt) await sleep(revealAt - elapsedBeforeReveal);
    if (revealTarget) {
      revealAvailability = mountedHidden ? 'hidden-mounted-terminal' : 'hidden-unmounted-terminal';
      const targetIndex = seeded.tabs.findIndex((tab) => tab.id === revealTarget.id);
      const marker = `O8_REVEAL_${sampleSeed}_${targetIndex}`;
      clients[targetIndex].send({ type: 'terminal-input', sessionName: revealTarget.sessionName, data: `O8_BENCH_REVEAL:${marker}\r` });
      await clients[targetIndex].waitForText(revealTarget.sessionName, marker, 10000);
      const markerSnapshot = (await clients[0].request('terminal-bench-stats')).data.snapshot;
      if (!markerSnapshot.sessions[revealTarget.sessionName]?.lastOutputTail.includes(marker)) {
        throw new Error(`server output tail did not contain paused reveal marker ${marker}`);
      }
      const reveal = await selectTabAndMeasure(page, revealTarget, marker);
      revealMs.push(round(reveal.revealMs));
      firstCorrectFrameMs.push(round(reveal.firstCorrectFrameMs));
      await clients[0].request('terminal-bench-visibility', {
        sessions: seeded.tabs.map((tab) => ({ sessionName: tab.sessionName, visible: tab.id === revealTarget.id })),
      });
      clients[targetIndex].send({ type: 'terminal-input', sessionName: revealTarget.sessionName, data: 'O8_BENCH_RESUME\r' });
    }

    await Promise.all(seeded.tabs.map((tab, index) => clients[index].waitForText(
      tab.sessionName,
      `O8_WORKLOAD_DONE_${tab.sessionName}_${sampleSeed}`,
      runConfig.durationMs + 30000,
    )));
    const observationMs = Date.now() - observationStartedAt;
    const after = snapshotProcesses();
    const processes = measureProcessGroups(before, after, groups, observationMs);
    const rawBrowser = await readPageStats(page);
    const performance = await readPerformance(page, observationMs);
    await context.close();
    context = null;
    await sleep(200);
    const rawServer = (await clients[0].request('terminal-bench-stats')).data.snapshot;
    const browserSummary = deriveBrowser(rawBrowser, seeded.tabs, panelInventory.mountedSessionNames);
    const serverSummary = deriveServer(rawServer, seeded.tabs, browserSummary.neverMountedSessionNames);
    const replayRisk = {
      sessionsWithObservedAltScreen: seeded.tabs.filter((tab) => {
        const alt = rawServer.sessions[tab.sessionName]?.alternateScreen;
        return alt?.observedEnter && alt?.observedExit;
      }).map((tab) => tab.sessionName),
      sessionsMissingRetainedAltEnter: seeded.tabs.filter((tab) => {
        const alt = rawServer.sessions[tab.sessionName]?.alternateScreen;
        return alt?.observedEnter && alt?.observedExit && !alt?.retainedEnter;
      }).map((tab) => tab.sessionName),
      sessionsWithRetainedAltExit: seeded.tabs.filter((tab) => rawServer.sessions[tab.sessionName]?.alternateScreen?.retainedExit).map((tab) => tab.sessionName),
    };
    return {
      schema: 'o8/terminal-workload-sample/v1',
      sessionCount,
      sampleIndex,
      seed: sampleSeed,
      buildMode: stack.buildMode,
      devModeCpuWarning: stack.devModeCpuWarning,
      observationMs,
      inventory: {
        terminalChipCount: seeded.tabs.length,
        orchestratorChipCount: ui.tabs.filter((tab) => tab.kind === 'orchestrator').length,
        activeTabId: ui.activeTabId,
        ptyCount: ptySessions.length,
        ptySessions,
        ...panelInventory,
        attachedClientsPerSession,
      },
      latency: {
        revealAvailability,
        revealMs,
        firstCorrectFrameMs,
        keystrokeToPaintMs: keystrokeToPaint.map((result) => round(result.elapsedMs)),
        keystrokeToPaintTimedOut: keystrokeToPaint.map((result) => result.timedOut),
        keystrokeToPaintTimeoutMs: 10000,
      },
      browser: browserSummary,
      server: serverSummary,
      performance: {
        ...performance,
        longTaskMs: round(performance.longTaskMs),
        longTaskMsPerMinute: round(performance.longTaskMsPerMinute),
        framesPerSecond: round(performance.framesPerSecond),
      },
      processes,
      replayRisk,
      raw: { browser: rawBrowser, server: rawServer, ui },
    };
  } catch (error) {
    const failure = {
      sessionCount,
      sampleIndex,
      runPrefix,
      error: error instanceof Error ? { message: error.message, stack: error.stack } : String(error),
      dashboard: page && !page.isClosed() ? await dashboardDiagnostic(page).catch(() => null) : null,
      nextLog: stack?.logs.next() ?? null,
      wsLog: stack?.logs.ws() ?? null,
    };
    fs.mkdirSync(runConfig.rawDir, { recursive: true });
    fs.writeFileSync(path.join(runConfig.rawDir, `failure-n${sessionCount}-sample-${sampleIndex}.json`), JSON.stringify(failure, null, 2));
    throw error;
  } finally {
    if (context) await context.close().catch(() => undefined);
    await Promise.all(clients.map((client) => client.close().catch(() => undefined)));
    if (stack) await stack.close().catch(() => undefined);
    else fs.rmSync(seeded.dataDir, { recursive: true, force: true });
    cleanupTmuxSessions(expectedSessionNames);
  }
}

async function main() {
  const runConfig = config();
  const browserPath = resolveBrowserPath();
  if (!browserPath) throw new Error('Chrome or Chromium is unavailable');
  fs.mkdirSync(runConfig.rawDir, { recursive: true });
  const browserTag = `o8-terminal-workload-${process.pid}-${Date.now()}`;
  const browser = await chromium.launch({
    executablePath: browserPath,
    headless: true,
    args: [
      '--disable-background-networking',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      `--o8-terminal-bench-id=${browserTag}`,
    ],
  });
  const browserProcesses = [...snapshotProcesses().values()].filter((process) => (
    process.command.includes(`--o8-terminal-bench-id=${browserTag}`)
  ));
  if (browserProcesses.length !== 1) {
    await browser.close();
    throw new Error(`unable to identify Chromium root process for ${browserTag}`);
  }
  const browserPid = browserProcesses[0].pid;
  const samples = [];
  try {
    for (const sessionCount of runConfig.sessionCounts) {
      for (let sampleIndex = 1; sampleIndex <= runConfig.samples; sampleIndex += 1) {
        process.stdout.write(`[bench:terminal] N=${sessionCount} sample=${sampleIndex}/${runConfig.samples}\n`);
        const sample = await runSample({ browser, browserPid, runConfig, sessionCount, sampleIndex });
        const samplePath = path.join(runConfig.rawDir, `n${sessionCount}-sample-${sampleIndex}.json`);
        fs.writeFileSync(samplePath, JSON.stringify(sample, null, 2));
        const { sessions: _browserSessions, ...browserSummary } = sample.browser;
        const { sessions: _serverSessions, ...serverSummary } = sample.server;
        void _browserSessions;
        void _serverSessions;
        samples.push({
          ...sample,
          browser: browserSummary,
          server: serverSummary,
          raw: undefined,
          artifact: path.relative(ROOT, samplePath).split(path.sep).join('/'),
        });
      }
    }
  } finally {
    await browser.close();
  }
  const buildModes = [...new Set(samples.map((sample) => sample.buildMode))];
  const receipt = {
    schema: 'o8/terminal-workload/v1',
    generatedAt: new Date().toISOString(),
    ...gitInfo(),
    buildMode: buildModes.length === 1 ? buildModes[0] : 'mixed',
    devModeCpuWarning: samples.some((sample) => sample.devModeCpuWarning),
    ...machineClass(),
    fixture: {
      id: 'terminal-ansi-alt-screen-v1',
      sessionCounts: runConfig.sessionCounts,
      samplesPerSessionCount: runConfig.samples,
      bytesPerSecondPerSession: runConfig.bytesPerSecond,
      durationMs: runConfig.durationMs,
      chunkMs: runConfig.chunkMs,
      seed: runConfig.seed,
      alternateScreen: { enterAtFraction: 0.25, exitAtFraction: 0.8, decset: 1049 },
    },
    sampleCount: samples.length,
    rawArtifactDirectory: path.relative(ROOT, runConfig.rawDir).split(path.sep).join('/'),
    summary: summarizeSamples(samples),
    samples,
  };
  fs.mkdirSync(path.dirname(runConfig.receiptPath), { recursive: true });
  fs.writeFileSync(runConfig.receiptPath, JSON.stringify(receipt, null, 2));
  process.stdout.write(`[bench:terminal] receipt ${path.relative(ROOT, runConfig.receiptPath)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`[bench:terminal] failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
