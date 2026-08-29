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
  describeProcessPidTree,
  measureProcessGroupMemory,
  measureProcessGroups,
  resolveProcessGroups,
  seedFixtureState,
  sleep,
  startIsolatedStack,
} from './terminal-workload/runtime.mjs';
import { connectTerminalClients } from './terminal-workload/ws-client.mjs';
import { summarizeSamples } from './terminal-workload/statistics.mjs';
import { assertTerminalWorkloadBudgets } from './terminal-workload/budgets.mjs';
import { ensureVisibleTerminal } from './terminal-workload/browser-state.mjs';

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
  const samples = Math.max(1, Number(option('samples', 3)) || 3);
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
    check: process.argv.includes('--check'),
    requestedBuildMode: String(option('build-mode', 'auto')),
    rawDir: path.resolve(option('output-dir', path.join(ROOT, 'tests/bench/latest/terminal-workload', runId))),
    receiptPath: path.resolve(option('receipt', path.join(ROOT, 'tests/bench/results/terminal-workload-phase2.json'))),
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
  window.__o8TerminalDiagnostics = [];
  window.__o8TerminalPerf = { startedAt: performance.now(), frames: 0, longTasks: [], longTaskSupported: false };
  window.addEventListener('o8:workspace-active-label', (event) => {
    const detail = event.detail;
    if (detail?.activeWorkspaceSurface && Array.isArray(detail.tabs)) {
      const pendingSessions = window.__o8TerminalBenchTabs?.pendingSessions;
      window.__o8TerminalBenchTabs = { ...detail, ...(pendingSessions ? { pendingSessions } : {}) };
    }
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

async function dashboardDiagnostic(page, seededTabs = []) {
  const sessionsByTabId = Object.fromEntries(seededTabs.map((tab) => [tab.id, tab.sessionName]));
  return page.evaluate((sessionLookup) => {
    const workspace = document.querySelector('[data-o8-workspace]');
    const rect = workspace instanceof HTMLElement ? workspace.getBoundingClientRect() : null;
    const panelStates = Object.fromEntries(Array.from(document.querySelectorAll('[data-o8-term-state]')).flatMap((element) => {
      const tabId = element.getAttribute('data-o8-term-tab');
      const sessionName = tabId ? sessionLookup[tabId] : null;
      const state = element.getAttribute('data-o8-term-state');
      return sessionName && state ? [[sessionName, state]] : [];
    }));
    return {
      hydrated: document.documentElement.getAttribute('data-o8-dashboard-hydrated'),
      workspaceCount: document.querySelectorAll('[data-o8-workspace]').length,
      workspaceRect: rect ? { width: rect.width, height: rect.height } : null,
      tabs: window.__o8TerminalBenchTabs?.tabs ?? null,
      pendingSessions: window.__o8TerminalBenchTabs?.pendingSessions ?? null,
      activeTabId: window.__o8TerminalBenchTabs?.tabId ?? null,
      chipIds: Array.from(document.querySelectorAll('[data-o8-workspace-tab]')).map((element) => element.getAttribute('data-o8-workspace-tab')),
      panelSessions: Array.from(document.querySelectorAll('[data-o8-term-panel]')).map((element) => ({
        sessionName: element.getAttribute('data-o8-term-panel'),
        display: getComputedStyle(element).display,
      })),
      panelStates,
      bodyText: document.body.innerText.slice(0, 1200),
    };
  }, sessionsByTabId);
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
    '--start-paused',
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

async function waitForPersistedTerminalSessions(stack, seeded) {
  const deadline = Date.now() + 20000;
  let consecutiveMatches = 0;
  let lastObserved = null;
  while (Date.now() < deadline) {
    const url = new URL(`http://127.0.0.1:${stack.apiPort}/api/panel/terminal-state`);
    url.searchParams.set('scope', 'tile-root');
    url.searchParams.set('repoPath', seeded.repoDir);
    const response = await fetch(url, { headers: { Authorization: `Bearer ${stack.token}` } });
    if (response.ok) {
      const state = await response.json();
      const tabs = Array.isArray(state?.tabs) ? state.tabs : [];
      lastObserved = Object.fromEntries(tabs.map((tab) => [tab.id, tab.tmuxSession ?? null]));
      const matches = seeded.tabs.every((tab) => lastObserved[tab.id] === tab.sessionName);
      consecutiveMatches = matches ? consecutiveMatches + 1 : 0;
      if (consecutiveMatches >= 3) return;
    } else {
      consecutiveMatches = 0;
      lastObserved = { status: response.status };
    }
    await sleep(350);
  }
  throw new Error(`terminal tab/session persistence did not stabilize: ${JSON.stringify(lastObserved)}`);
}

async function prepareShell(client, observer, sessionName, seed) {
  const marker = `O8_SHELL_READY_${sessionName}_${seed}`;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    client.send({
      type: 'terminal-input',
      sessionName,
      data: `\x03printf '${marker}\\n'\r`,
    });
    try {
      await observer.waitForServerText(sessionName, marker, 5000);
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
    window.__o8TerminalDiagnostics = [];
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
      diagnostics: [...(window.__o8TerminalDiagnostics ?? [])],
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

async function browserTerminalSize(page, sessionName) {
  return page.evaluate((targetSession) => {
    const session = window.__o8TerminalWriteStats?.sessions[targetSession];
    return { cols: session?.cols ?? 0, rows: session?.rows ?? 0 };
  }, sessionName);
}

async function browserTerminalSizeDiagnostic(page, sessionName) {
  return page.evaluate((targetSession) => {
    const sessions = window.__o8TerminalWriteStats?.sessions ?? {};
    const panel = document.querySelector(`[data-o8-term-panel="${CSS.escape(targetSession)}"]`);
    return {
      sessionKeys: Object.keys(sessions),
      sessions: Object.fromEntries(Object.entries(sessions).map(([key, session]) => [key, {
        cols: session.cols,
        rows: session.rows,
        mountCount: session.mountCount,
        mounted: session.mounted,
      }])),
      fontStatus: document.fonts?.status ?? 'unsupported',
      loadingWorkspacePresent: document.querySelector('[aria-label="Loading workspace"]') !== null,
      xtermElementCount: panel?.querySelectorAll('.xterm').length ?? 0,
      performanceNow: performance.now(),
    };
  }, sessionName);
}

async function waitForBrowserTerminalSize(page, sessionName, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let size = { cols: 0, rows: 0 };
  while (Date.now() < deadline) {
    size = await browserTerminalSize(page, sessionName);
    if (size.cols > 0 && size.rows > 0) return size;
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve())));
  }
  const error = new Error(`browser terminal grid unavailable for ${sessionName}: ${size.cols}x${size.rows}`);
  error.terminalSizeFailure = await browserTerminalSizeDiagnostic(page, sessionName);
  throw error;
}

async function waitForSharedTerminalGrid(page, sessionName, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  let browserSize = { cols: 0, rows: 0 };
  let tmuxSize = { cols: 0, rows: 0 };
  let matchedSize = '';
  let matchedAt = 0;
  while (Date.now() < deadline) {
    browserSize = await browserTerminalSize(page, sessionName);
    tmuxSize = captureTmuxSize(sessionName);
    const matches = (
      browserSize.cols > 0
      && browserSize.rows > 0
      && browserSize.cols === tmuxSize.cols
      && browserSize.rows === tmuxSize.rows
    );
    const sizeKey = `${browserSize.cols}x${browserSize.rows}`;
    if (matches && sizeKey === matchedSize) {
      if (Date.now() - matchedAt >= 100) return browserSize;
    } else if (matches) {
      matchedSize = sizeKey;
      matchedAt = Date.now();
    } else {
      matchedSize = '';
      matchedAt = 0;
    }
    await sleep(25);
  }
  throw new Error(
    `terminal reveal grid did not settle for ${sessionName}: browser=${browserSize.cols}x${browserSize.rows} tmux=${tmuxSize.cols}x${tmuxSize.rows}`,
  );
}

function terminalScreenDifferences(rendered, oracle) {
  const renderedLines = rendered.split('\n');
  const oracleLines = oracle.split('\n');
  const differingLines = [];
  for (let index = 0; index < Math.max(renderedLines.length, oracleLines.length); index += 1) {
    if (renderedLines[index] === oracleLines[index]) continue;
    differingLines.push({ line: index + 1, rendered: renderedLines[index] ?? '', oracle: oracleLines[index] ?? '' });
    if (differingLines.length === 20) break;
  }
  return differingLines;
}

async function waitForCorrectTerminalScreen(page, sessionName, grid, startedAt, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let rendered = '';
  let oracle = '';
  let tmuxSize = captureTmuxSize(sessionName);
  while (Date.now() < deadline) {
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve())));
    tmuxSize = captureTmuxSize(sessionName);
    const tmuxScreen = terminalScreenOracle(captureTmuxText(sessionName));
    rendered = normalizeTerminalText(await panelText(page, sessionName, grid.rows));
    oracle = tmuxScreen.text;
    if (
      tmuxSize.cols === grid.cols
      && tmuxSize.rows === grid.rows
      && tmuxScreen.rows === grid.rows
      && rendered === oracle
    ) {
      const correctAt = await page.evaluate(() => performance.now());
      return { firstCorrectFrameMs: correctAt - startedAt, screen: tmuxScreen };
    }
  }
  const differences = terminalScreenDifferences(rendered, oracle);
  throw new Error(
    `terminal screen did not match tmux oracle for ${sessionName}: browser=${grid.cols}x${grid.rows} tmux=${tmuxSize.cols}x${tmuxSize.rows} differences=${JSON.stringify(differences).replaceAll('\\u001b', 'ESC')}`,
  );
}

async function selectTabAndMeasure(page, tab) {
  const startedAt = await page.evaluate(() => performance.now());
  await page.locator(`[data-o8-workspace-tab="${tab.id}"]`).click();
  await page.waitForFunction(({ sessionName, tabId }) => {
    const panel = document.querySelector(`[data-o8-term-panel="${CSS.escape(sessionName)}"]`);
    return panel && getComputedStyle(panel).display !== 'none' && window.__o8TerminalBenchTabs?.tabId === tabId;
  }, { sessionName: tab.sessionName, tabId: tab.id }, { polling: 'raf', timeout: 10000 });
  const visibleAt = await page.evaluate(() => performance.now());
  const grid = await waitForSharedTerminalGrid(page, tab.sessionName);
  const correct = await waitForCorrectTerminalScreen(page, tab.sessionName, grid, startedAt);
  return { revealMs: visibleAt - startedAt, grid, ...correct };
}

function normalizeTerminalText(value) {
  const lines = String(value).replaceAll('\r', '').split('\n').map((line) => line.replace(/\s+$/u, ''));
  while (lines.length > 0 && lines.at(-1) === '') lines.pop();
  return lines.join('\n');
}

function terminalScreenOracle(value) {
  const lines = String(value).replaceAll('\r', '').split('\n');
  if (lines.at(-1) === '') lines.pop();
  return {
    rows: lines.length,
    text: normalizeTerminalText(lines.join('\n')),
  };
}

function captureTmuxText(sessionName) {
  // #1979: tmux CSI n S scrolling cannot preserve history in xterm.js; screen state remains authoritative.
  return execFileSync('tmux', ['capture-pane', '-p', '-t', sessionName], { encoding: 'utf8' });
}

function captureTmuxSize(sessionName) {
  const value = execFileSync(
    'tmux',
    ['display-message', '-p', '-t', sessionName, '#{pane_width} #{pane_height}'],
    { encoding: 'utf8' },
  ).trim();
  const [cols, rows] = value.split(/\s+/u).map(Number);
  if (!Number.isSafeInteger(cols) || cols < 1 || !Number.isSafeInteger(rows) || rows < 1) {
    throw new Error(`invalid tmux pane size for ${sessionName}: ${value}`);
  }
  return { cols, rows };
}

async function captureQuiescentTmuxText(client, sessionName) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const snapshot = (await client.request('terminal-bench-stats')).data.snapshot;
    const lastOutputAt = snapshot.sessions[sessionName]?.lastOutputAt;
    if (!Number.isFinite(lastOutputAt) || Date.now() - lastOutputAt < 100) {
      await sleep(25);
      continue;
    }
    const first = captureTmuxText(sessionName);
    await sleep(100);
    const second = captureTmuxText(sessionName);
    if (first === second) return second;
  }
  throw new Error(`tmux oracle for ${sessionName} did not become idle and stable within 2000ms`);
}

async function panelText(page, sessionName, lines = 1000) {
  return page.evaluate(({ targetSession, lineCount }) => (
    window.__o8TerminalWriteStats?.sessions[targetSession]?.readText(lineCount) ?? ''
  ), { targetSession: sessionName, lineCount: lines });
}

function tmuxLastRows(sessionName, rowCount) {
  try {
    const lines = captureTmuxText(sessionName).replace(/\n$/u, '').split('\n');
    return { output: lines.slice(-rowCount).join('\n'), error: null };
  } catch (error) {
    return { output: null, error: error instanceof Error ? error.message : String(error) };
  }
}

function tmuxPaneState(sessionName) {
  try {
    return {
      output: execFileSync(
        'tmux',
        ['display-message', '-p', '-t', sessionName, '#{pane_dead} #{pane_pid} #{pane_current_command}'],
        { encoding: 'utf8' },
      ).trim(),
      error: null,
    };
  } catch (error) {
    return { output: null, error: error instanceof Error ? error.message : String(error) };
  }
}

function generatorPidFromLog(logContents) {
  for (const line of logContents.split('\n').filter(Boolean)) {
    try {
      const entry = JSON.parse(line);
      if (entry.event === 'start' && Number.isSafeInteger(entry.pid)) return entry.pid;
    } catch { /* retained verbatim below for diagnosis */ }
  }
  return null;
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function captureRapidFailure({ client, sessionName, marker, logPath, startSnapshot, revealCount }) {
  let snapshot = null;
  let snapshotError = null;
  try {
    snapshot = (await client.request('terminal-bench-stats')).data.snapshot;
  } catch (error) {
    snapshotError = error instanceof Error ? error.message : String(error);
  }
  const session = snapshot?.sessions?.[sessionName] ?? null;
  const startSession = startSnapshot.sessions?.[sessionName] ?? null;
  let generatorLogContents = '';
  let generatorLogError = null;
  try {
    generatorLogContents = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
  } catch (error) {
    generatorLogError = error instanceof Error ? error.message : String(error);
  }
  const generatorPid = generatorPidFromLog(generatorLogContents);
  return {
    sessionName,
    marker,
    lastOutputTail: session?.lastOutputTail ?? null,
    lastOutputTailBytes: typeof session?.lastOutputTail === 'string'
      ? Buffer.byteLength(session.lastOutputTail, 'utf8')
      : null,
    lastOutputTailByteCap: snapshot?.lastOutputTailByteCap ?? null,
    serverSnapshotError: snapshotError,
    tmuxCapturePaneLast12Rows: tmuxLastRows(sessionName, 12),
    tmuxPaneState: tmuxPaneState(sessionName),
    generatorLogPath: path.relative(ROOT, logPath).split(path.sep).join('/'),
    generatorPid,
    generatorPidAlive: processIsAlive(generatorPid),
    generatorLogContents,
    generatorLogError,
    attachDetachDuringLoop: {
      attachedClientCountStart: startSession?.attachedClientCount ?? null,
      attachedClientCountEnd: session?.attachedClientCount ?? null,
      attachEvents: Number.isFinite(startSession?.attachEvents) && Number.isFinite(session?.attachEvents)
        ? session.attachEvents - startSession.attachEvents
        : null,
      detachEvents: Number.isFinite(startSession?.detachEvents) && Number.isFinite(session?.detachEvents)
        ? session.detachEvents - startSession.detachEvents
        : null,
    },
    browserRevealCount: revealCount,
  };
}

async function runRapidSwitch(page, seeded, clients, rapidGeneratorPath, runDirectory) {
  const durationMs = 30000;
  const intervalMs = 100;
  const expectedSequenceCount = Math.ceil(durationMs / intervalMs);
  const logPaths = Object.fromEntries(seeded.tabs.map((tab) => [
    tab.sessionName,
    path.join(runDirectory, `rapid-${tab.sessionName}.log`),
  ]));
  for (const [index, tab] of seeded.tabs.entries()) {
    clients[index].send({
      type: 'terminal-input',
      sessionName: tab.sessionName,
      data: `${shellQuote(process.execPath)} ${shellQuote(rapidGeneratorPath)} --session ${shellQuote(tab.sessionName)} --duration-ms ${durationMs} --interval-ms ${intervalMs} --log ${shellQuote(logPaths[tab.sessionName])}\r`,
    });
  }
  await Promise.all(seeded.tabs.map((tab) => clients[0].waitForServerText(
    tab.sessionName,
    `O8_RAPID_READY_${tab.sessionName}`,
    15000,
  )));

  const rapidStartSnapshot = (await clients[0].request('terminal-bench-stats')).data.snapshot;
  const startedAt = Date.now();
  let switchCount = 0;
  const revealCounts = Object.fromEntries(seeded.tabs.map((tab) => [tab.sessionName, 0]));
  while (Date.now() - startedAt < durationMs) {
    const tab = seeded.tabs[switchCount % seeded.tabs.length];
    await page.locator(`[data-o8-workspace-tab="${tab.id}"]`).click();
    await page.waitForFunction(({ tabId, sessionName }) => {
      const panel = document.querySelector(`[data-o8-term-panel="${CSS.escape(sessionName)}"]`);
      return window.__o8TerminalBenchTabs?.tabId === tabId
        && panel != null
        && getComputedStyle(panel).display !== 'none';
    }, { tabId: tab.id, sessionName: tab.sessionName }, { polling: 'raf', timeout: 10000 });
    switchCount += 1;
    revealCounts[tab.sessionName] += 1;
    const remaining = 200 - ((Date.now() - startedAt) % 200);
    if (remaining > 0 && remaining < 200) await sleep(remaining);
  }
  const doneResults = await Promise.allSettled(seeded.tabs.map((tab) => clients[0].waitForServerText(
    tab.sessionName,
    `O8_RAPID_DONE_${tab.sessionName}_${expectedSequenceCount}`,
    15000,
  )));
  const failedTabs = seeded.tabs.filter((_, index) => doneResults[index].status === 'rejected');
  if (failedTabs.length > 0) {
    const failures = [];
    for (const tab of failedTabs) {
      failures.push(await captureRapidFailure({
        client: clients[0],
        sessionName: tab.sessionName,
        marker: `O8_RAPID_DONE_${tab.sessionName}_${expectedSequenceCount}`,
        logPath: logPaths[tab.sessionName],
        startSnapshot: rapidStartSnapshot,
        revealCount: revealCounts[tab.sessionName],
      }));
    }
    const error = new Error(`rapid-switch DONE wait timed out for ${failedTabs.map((tab) => tab.sessionName).join(', ')}`);
    error.rapidSwitchFailure = { timeoutMs: 15000, failures };
    throw error;
  }

  const finalTab = seeded.tabs.at(-1);
  await page.locator(`[data-o8-workspace-tab="${finalTab.id}"]`).click();
  await page.waitForFunction(({ tabId, sessionName, doneMarker }) => {
    const panel = document.querySelector(`[data-o8-term-panel="${CSS.escape(sessionName)}"]`);
    return window.__o8TerminalBenchTabs?.tabId === tabId
      && panel != null
      && getComputedStyle(panel).display !== 'none'
      && window.__o8TerminalWriteStats?.sessions[sessionName]?.readText(1000).includes(doneMarker) === true;
  }, {
    tabId: finalTab.id,
    sessionName: finalTab.sessionName,
    doneMarker: `O8_RAPID_DONE_${finalTab.sessionName}_${expectedSequenceCount}`,
  }, { polling: 'raf', timeout: 15000 });
  const grid = await waitForSharedTerminalGrid(page, finalTab.sessionName);
  const tmuxScreen = terminalScreenOracle(await captureQuiescentTmuxText(clients[0], finalTab.sessionName));
  const text = normalizeTerminalText(await panelText(page, finalTab.sessionName, grid.rows));
  if (tmuxScreen.rows !== grid.rows || text !== tmuxScreen.text) {
    const tmuxSize = captureTmuxSize(finalTab.sessionName);
    throw new Error(
      `rapid-switch screen mismatch for ${finalTab.sessionName}: browser=${grid.cols}x${grid.rows} tmux=${tmuxSize.cols}x${tmuxSize.rows} differences=${JSON.stringify(terminalScreenDifferences(text, tmuxScreen.text))}`,
    );
  }
  const markerPattern = new RegExp(`O8_RAPID_${finalTab.sessionName}_(\\d{5})`, 'g');
  const observed = [...text.matchAll(markerPattern)]
    .map((match) => Number(match[1]));
  const expected = [...tmuxScreen.text.matchAll(markerPattern)].map((match) => Number(match[1]));
  if (JSON.stringify(observed) !== JSON.stringify(expected)) {
    throw new Error(`rapid-switch screen sequence mismatch for ${finalTab.sessionName}`);
  }
  if (new Set(observed).size !== observed.length) {
    throw new Error(`rapid-switch duplicate screen sequence for ${finalTab.sessionName}`);
  }
  return {
    passed: true,
    durationMs: Date.now() - startedAt,
    switchCount,
    finalSessionName: finalTab.sessionName,
    expectedSequenceCount,
    observedSequenceCount: observed.length,
  };
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
    diagnostics: raw.diagnostics,
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
  const browserConsole = [];
  const httpFailures = [];
  try {
    stack = await startIsolatedStack(ROOT, seeded, runConfig.requestedBuildMode);
    context = await browser.newContext({ viewport: { width: 1000, height: 800 } });
    page = await context.newPage();
    page.on('console', (message) => {
      browserConsole.push({ type: message.type(), text: message.text() });
      if (browserConsole.length > 2000) browserConsole.shift();
    });
    page.on('response', (response) => {
      if (response.status() < 400 || httpFailures.length >= 200) return;
      httpFailures.push({ url: response.url(), status: response.status() });
    });
    await page.addInitScript(browserInitScript);
    let ui = await waitForSeededDashboard(page, `http://127.0.0.1:${stack.apiPort}`, seeded);
    await waitForPanelContract(page, seeded.tabs[0].sessionName);
    const terminalSize = await waitForBrowserTerminalSize(page, seeded.tabs[0].sessionName);
    const wsUrl = `ws://127.0.0.1:${stack.wsPort}/ws?token=${encodeURIComponent(stack.token)}`;
    clients = await connectTerminalClients(wsUrl, sessionCount);
    await Promise.all(seeded.tabs.map((tab, index) => clients[index].createAndAttach({
      ownerKey: `workspace:${tab.id}`,
      requestId: `bench-${runPrefix}-${index + 1}`,
      sessionName: tab.sessionName,
      cwd: seeded.repoDir,
      ...terminalSize,
    })));
    await waitForPersistedTerminalSessions(stack, seeded);
    // The first load supplies the real browser grid. Reload after every PTY is
    // materialized so restore observes a complete session inventory instead
    // of racing terminal-created acknowledgements during the rapid-switch run.
    ui = await waitForSeededDashboard(page, `http://127.0.0.1:${stack.apiPort}`, seeded);
    const panelInventory = await waitForPanelContract(page, seeded.tabs[0].sessionName);
    await Promise.all(seeded.tabs.map((tab, index) => (
      prepareShell(clients[index], clients[0], tab.sessionName, sampleSeed)
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
    const generatorPath = path.join(ROOT, 'scripts/bench/terminal-workload/generator.mjs');
    for (const [index, tab] of seeded.tabs.entries()) {
      clients[index].send({
        type: 'terminal-input',
        sessionName: tab.sessionName,
        data: `${generatorCommand(generatorPath, tab.sessionName, runConfig, sampleSeed)}\r`,
      });
    }
    await Promise.all(seeded.tabs.map((tab) => clients[0].waitForServerText(
      tab.sessionName,
      `O8_WORKLOAD_READY_${tab.sessionName}_${sampleSeed}`,
      30000,
    )));
    await resetPageMeasurement(page);
    const deliveryStarts = seeded.tabs.map((tab, index) => clients[index].terminalDelivery(tab.sessionName));

    const before = snapshotProcesses();
    const groups = resolveProcessGroups(before, stack, browserPid);
    const processPidTreeStart = describeProcessPidTree(before, groups);
    const physicalBytesStart = measureProcessGroupMemory(before, groups);
    for (const [index, tab] of seeded.tabs.entries()) {
      clients[index].send({
        type: 'terminal-input',
        sessionName: tab.sessionName,
        data: 'O8_BENCH_RESUME\r',
      });
    }
    const observationStartedAt = Date.now();

    await sleep(700);
    const keystrokeToPaint = [];
    let visibleTarget = { tab: seeded.tabs[0], mountedSessionNames: panelInventory.mountedSessionNames };
    for (let index = 0; index < 3; index += 1) {
      visibleTarget = await ensureVisibleTerminal(page, seeded.tabs);
      const marker = `O8K_${sampleSeed}_${index}`;
      keystrokeToPaint.push(await measureKeystrokeToPaint(page, visibleTarget.tab.sessionName, marker));
      await sleep(100);
    }

    const revealMs = [];
    const firstCorrectFrameMs = [];
    const correctness = { failures: 0, timeouts: 0, alternateScreenOracleMatches: 0 };
    let revealAvailability = 'not-applicable-single-terminal';
    const mountedHidden = seeded.tabs.find((tab) => (
      visibleTarget.mountedSessionNames.includes(tab.sessionName) && tab.sessionName !== visibleTarget.tab.sessionName
    ));
    const revealTarget = mountedHidden ?? seeded.tabs.find((tab) => tab.sessionName !== visibleTarget.tab.sessionName);
    const revealAt = Math.floor(runConfig.durationMs * 0.55);
    const elapsedBeforeReveal = Date.now() - observationStartedAt;
    if (elapsedBeforeReveal < revealAt) await sleep(revealAt - elapsedBeforeReveal);
    if (revealTarget) {
      revealAvailability = mountedHidden ? 'hidden-mounted-terminal' : 'hidden-unmounted-terminal';
      const targetIndex = seeded.tabs.findIndex((tab) => tab.id === revealTarget.id);
      const marker = `O8_REVEAL_${sampleSeed}_${targetIndex}`;
      clients[targetIndex].send({ type: 'terminal-input', sessionName: revealTarget.sessionName, data: `O8_BENCH_REVEAL:${marker}\r` });
      await clients[0].waitForServerText(revealTarget.sessionName, marker, 10000);
      const markerSnapshot = (await clients[0].request('terminal-bench-stats')).data.snapshot;
      if (!markerSnapshot.sessions[revealTarget.sessionName]?.lastOutputTail.includes(marker)) {
        throw new Error(`server output tail did not contain paused reveal marker ${marker}`);
      }
      const reveal = await selectTabAndMeasure(page, revealTarget);
      revealMs.push(round(reveal.revealMs));
      firstCorrectFrameMs.push(round(reveal.firstCorrectFrameMs));
      const postRevealGrid = await waitForSharedTerminalGrid(page, revealTarget.sessionName);
      const tmuxScreen = terminalScreenOracle(captureTmuxText(revealTarget.sessionName));
      const browserText = normalizeTerminalText(await panelText(
        page,
        revealTarget.sessionName,
        postRevealGrid.rows,
      ));
      if (
        tmuxScreen.rows !== postRevealGrid.rows
        || browserText !== tmuxScreen.text
      ) {
        correctness.failures += 1;
        throw new Error(
          `post-reveal screen mismatch for ${revealTarget.sessionName}: browser=${postRevealGrid.cols}x${postRevealGrid.rows} tmux=${captureTmuxSize(revealTarget.sessionName).cols}x${captureTmuxSize(revealTarget.sessionName).rows} differences=${JSON.stringify(terminalScreenDifferences(browserText, tmuxScreen.text))}`,
        );
      }
      correctness.alternateScreenOracleMatches += 1;
      await clients[0].request('terminal-bench-visibility', {
        sessions: seeded.tabs.map((tab) => ({ sessionName: tab.sessionName, visible: tab.id === revealTarget.id })),
      });
      clients[targetIndex].send({ type: 'terminal-input', sessionName: revealTarget.sessionName, data: 'O8_BENCH_RESUME\r' });
    }

    await Promise.all(seeded.tabs.map((tab) => clients[0].waitForServerText(
      tab.sessionName,
      `O8_WORKLOAD_DONE_${tab.sessionName}_${sampleSeed}`,
      runConfig.durationMs + 30000,
    )));
    const observationMs = Date.now() - observationStartedAt;
    const after = snapshotProcesses();
    const groupsAfter = resolveProcessGroups(after, stack, browserPid);
    const processPidTreeEnd = describeProcessPidTree(after, groupsAfter);
    const physicalBytesEnd = measureProcessGroupMemory(after, groupsAfter);
    const processes = measureProcessGroups(before, after, groups, observationMs, physicalBytesStart, physicalBytesEnd);
    const rawBrowser = await readPageStats(page);
    if (mountedHidden && !rawBrowser.diagnostics.some((diagnostic) => (
      diagnostic.code === 'terminal_client_hidden_overflow'
      && diagnostic.sessionName === mountedHidden.sessionName
    ))) {
      correctness.failures += 1;
      throw new Error(`hidden client buffer did not overflow for ${mountedHidden.sessionName}`);
    }
    const performance = await readPerformance(page, observationMs);
    const rawServer = (await clients[0].request('terminal-bench-stats')).data.snapshot;
    const resyncUnsettledCount = rawBrowser.diagnostics.filter((diagnostic) => (
      diagnostic.code === 'terminal_resync_unsettled'
    )).length;
    const resyncFailedCount = rawBrowser.diagnostics.filter((diagnostic) => (
      diagnostic.code === 'terminal_resync_failed'
    )).length;
    const deliveryEnds = seeded.tabs.map((tab, index) => clients[index].terminalDelivery(tab.sessionName));
    const hiddenDeliveredBytesPerHiddenClient = deliveryEnds.map((delivery, index) => delivery.bytes - deliveryStarts[index].bytes);
    const hiddenDeliveriesPerHiddenClient = deliveryEnds.map((delivery, index) => delivery.frames - deliveryStarts[index].frames);
    const rapidSwitch = sessionCount === 12
      ? await runRapidSwitch(
        page,
        seeded,
        clients,
        path.join(ROOT, 'scripts/bench/terminal-workload/rapid-generator.mjs'),
        runConfig.rawDir,
      )
      : null;
    await context.close();
    context = null;
    await sleep(200);
    const browserSummary = deriveBrowser(rawBrowser, seeded.tabs, panelInventory.mountedSessionNames);
    const serverSummary = deriveServer(rawServer, seeded.tabs, browserSummary.neverMountedSessionNames);
    serverSummary.hiddenDeliveredBytesPerHiddenClient = hiddenDeliveredBytesPerHiddenClient;
    serverSummary.hiddenDeliveriesPerHiddenClient = hiddenDeliveriesPerHiddenClient;
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
    const orchestratorLaunches = stack.logs.ws().match(/\[orchestrator-session\] Created /gu)?.length ?? 0;
    return {
      schema: 'o8/terminal-workload-sample/v1',
      sessionCount,
      sampleIndex,
      seed: sampleSeed,
      buildMode: stack.buildMode,
      devModeCpuWarning: stack.devModeCpuWarning,
      observationMs,
      orchestratorLaunches,
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
      processPidTree: {
        roots: {
          applicationServer: stack.nextPid,
          realtimeServer: stack.wsPid,
          chromium: browserPid,
        },
        start: processPidTreeStart,
        end: processPidTreeEnd,
      },
      correctness,
      diagnostics: { resyncUnsettledCount, resyncFailedCount },
      rapidSwitch,
      replayRisk,
      raw: { browser: rawBrowser, server: rawServer, ui, browserConsole, httpFailures },
    };
  } catch (error) {
    const failure = {
      sessionCount,
      sampleIndex,
      runPrefix,
      error: error instanceof Error ? { message: error.message, stack: error.stack } : String(error),
      dashboard: page && !page.isClosed() ? await dashboardDiagnostic(page, seeded.tabs).catch(() => null) : null,
      browserConsole,
      httpFailures,
      terminalSizeFailure: error instanceof Error ? error.terminalSizeFailure ?? null : null,
      nextLog: stack?.logs.next() ?? null,
      wsLog: stack?.logs.ws() ?? null,
      rapidSwitchFailure: error instanceof Error ? error.rapidSwitchFailure ?? null : null,
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
  if (runConfig.check) {
    const receipt = JSON.parse(fs.readFileSync(runConfig.receiptPath, 'utf8'));
    assertTerminalWorkloadBudgets(receipt);
    process.stdout.write(`[bench:terminal] locked budgets passed for ${path.relative(ROOT, runConfig.receiptPath)}\n`);
    return;
  }
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
      id: 'terminal-ansi-alt-screen-visibility-v2',
      sessionCounts: runConfig.sessionCounts,
      samplesPerSessionCount: runConfig.samples,
      bytesPerSecondPerSession: runConfig.bytesPerSecond,
      durationMs: runConfig.durationMs,
      chunkMs: runConfig.chunkMs,
      seed: runConfig.seed,
      alternateScreen: { enterAtFraction: 0.25, exitAtFraction: 0.8, decset: 1049 },
      visibilityAware: {
        serverHiddenCadenceMs: 250,
        serverHiddenBufferBytes: 64 * 1024,
        clientHiddenBufferBytes: 256 * 1024,
        rapidSwitch: { sessionCount: 12, durationMs: 30000, sequenceIntervalMs: 100 },
      },
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
