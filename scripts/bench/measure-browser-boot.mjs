#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

const METRICS = [
  'time_to_splash_ms',
  'time_to_reveal_ms',
  'boot_api_request_count',
  'max_client_queue_stall_ms',
  'panel_branches_ms',
  'runtime_inventory_ms',
];

function nullMetric(note) {
  return { value: null, note };
}

function emptyMetrics(note) {
  return Object.fromEntries(METRICS.map((name) => [name, nullMetric(note)]));
}

function unavailableTarget(note) {
  return {
    appVersion: null,
    buildGitSha: null,
    buildMode: null,
    platform: null,
    unavailableReason: note,
  };
}

export function targetFromPanelStatus(payload) {
  if (!payload || typeof payload !== 'object') return unavailableTarget('panel status response was invalid');
  const appVersion = typeof payload.version === 'string' && payload.version.trim()
    ? payload.version.trim()
    : null;
  const buildGitSha = typeof payload.buildGitSha === 'string' && /^[0-9a-f]{40}$/i.test(payload.buildGitSha)
    ? payload.buildGitSha.toLowerCase()
    : null;
  const buildMode = ['packaged', 'production', 'development'].includes(payload.buildMode)
    ? payload.buildMode
    : null;
  const platform = typeof payload.platform === 'string' && payload.platform.trim()
    ? payload.platform.trim()
    : null;
  const missing = [
    !appVersion ? 'app version' : null,
    !buildGitSha ? 'build Git SHA' : null,
    !buildMode ? 'build mode' : null,
  ].filter(Boolean);
  return {
    appVersion,
    buildGitSha,
    buildMode,
    platform,
    unavailableReason: missing.length > 0 ? `${missing.join(', ')} unavailable from running target` : null,
  };
}

async function readTarget(baseUrl) {
  try {
    const response = await fetch(`${baseUrl}/api/panel/status`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return unavailableTarget(`/api/panel/status returned ${response.status}`);
    return targetFromPanelStatus(await response.json());
  } catch (error) {
    return unavailableTarget(`/api/panel/status failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function readPort() {
  try {
    return fs.readFileSync(path.join(os.homedir(), '.o8/api-port'), 'utf8').trim() || '3001';
  } catch {
    return '3001';
  }
}

export function browserCandidates() {
  return [
    process.env.O8_BENCH_BROWSER_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe')
      : null,
    process.env.PROGRAMFILES
      ? path.join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe')
      : null,
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
}

export function resolveBrowserPath() {
  return browserCandidates().find((candidate) => fs.existsSync(candidate)) ?? null;
}

function rounded(value) {
  return Number.isFinite(value) ? Number(value.toFixed(1)) : null;
}

export function summarizeBrowserPerformanceEntries(entries) {
  const apiEntries = entries.filter((entry) => {
    try {
      return new URL(entry.name).pathname.startsWith('/api/');
    } catch {
      return false;
    }
  });
  const queueStalls = apiEntries
    .map((entry) => Number(entry.requestStart) - Number(entry.fetchStart))
    .filter((value) => Number.isFinite(value) && value >= 0);
  return {
    bootApiRequestCount: apiEntries.length,
    maxClientQueueStallMs: rounded(queueStalls.length > 0 ? Math.max(...queueStalls) : 0),
  };
}

async function probeTrackedRoutes(page) {
  return page.evaluate(async () => {
    async function timedFetch(url) {
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), 20_000);
      const startedAt = performance.now();
      try {
        const response = await fetch(url, { cache: 'no-store', signal: controller.signal });
        await response.text();
        const elapsedMs = Math.round((performance.now() - startedAt) * 10) / 10;
        return response.ok
          ? { value: elapsedMs }
          : { value: null, note: `${url} returned ${response.status}` };
      } catch (error) {
        return {
          value: null,
          note: `${url} failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      } finally {
        window.clearTimeout(timer);
      }
    }

    const inventory = await timedFetch('/api/runtime/inventory');
    let branch = { value: null, note: 'no registered repository available for branch timing' };
    try {
      const response = await fetch('/api/panel/repos', { cache: 'no-store' });
      if (!response.ok) {
        branch = { value: null, note: `/api/panel/repos returned ${response.status}` };
      } else {
        const payload = await response.json();
        const repoPath = Array.isArray(payload?.repos)
          ? payload.repos.find((repo) => typeof repo?.localPath === 'string')?.localPath
          : null;
        if (repoPath) {
          branch = await timedFetch(`/api/panel/branches?path=${encodeURIComponent(repoPath)}`);
        }
      }
    } catch (error) {
      branch = {
        value: null,
        note: `repository lookup failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    return { inventory, branch };
  });
}

async function measureBrowserBoot() {
  const browserPath = resolveBrowserPath();
  if (!browserPath) return emptyMetrics('Chrome or Chromium is unavailable');

  const baseUrl = (process.env.BASE_URL || `http://127.0.0.1:${readPort()}`).replace(/\/$/, '');
  const timeoutMs = Math.min(60_000, Math.max(5_000, Number(process.env.O8_BENCH_BOOT_TIMEOUT_MS) || 30_000));
  const browser = await chromium.launch({
    executablePath: browserPath,
    headless: true,
    args: ['--disable-background-networking'],
  });

  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.addInitScript(() => {
      globalThis.__o8BenchmarkBoot = { splashMs: null, revealMs: null, splashSeen: false };
      const observe = () => {
        const loader = document.querySelector('[aria-label="Loading workspace"]');
        const visible = Boolean(loader && getComputedStyle(loader).display !== 'none');
        if (visible && globalThis.__o8BenchmarkBoot.splashMs === null) {
          globalThis.__o8BenchmarkBoot.splashMs = performance.now();
          globalThis.__o8BenchmarkBoot.splashSeen = true;
        }
        if (!visible
          && globalThis.__o8BenchmarkBoot.splashSeen
          && globalThis.__o8BenchmarkBoot.revealMs === null) {
          globalThis.__o8BenchmarkBoot.revealMs = performance.now();
        }
        if (globalThis.__o8BenchmarkBoot.revealMs === null) requestAnimationFrame(observe);
      };
      requestAnimationFrame(observe);
    });

    const response = await page.goto(`${baseUrl}/dashboard`, {
      waitUntil: 'domcontentloaded',
      timeout: timeoutMs,
    });
    if (!response?.ok()) return emptyMetrics(`/dashboard returned ${response?.status() ?? 'no response'}`);

    await page.waitForFunction(
      () => globalThis.__o8BenchmarkBoot?.revealMs !== null,
      undefined,
      { timeout: timeoutMs },
    ).catch(() => undefined);

    const boot = await page.evaluate(() => {
      const state = globalThis.__o8BenchmarkBoot;
      const revealBoundary = typeof state?.revealMs === 'number' ? state.revealMs : performance.now();
      const entries = performance.getEntriesByType('resource')
        .filter((entry) => entry.startTime <= revealBoundary)
        .map((entry) => ({
          name: entry.name,
          fetchStart: entry.fetchStart,
          requestStart: entry.requestStart,
        }));
      return { state, entries };
    });
    const performanceSummary = summarizeBrowserPerformanceEntries(boot.entries);
    const routeProbes = await probeTrackedRoutes(page);

    return {
      time_to_splash_ms: typeof boot.state?.splashMs === 'number'
        ? rounded(boot.state.splashMs)
        : nullMetric('workspace splash was not observed'),
      time_to_reveal_ms: typeof boot.state?.revealMs === 'number'
        ? rounded(boot.state.revealMs)
        : nullMetric(`workspace reveal was not observed within ${timeoutMs}ms`),
      boot_api_request_count: performanceSummary.bootApiRequestCount,
      max_client_queue_stall_ms: performanceSummary.maxClientQueueStallMs,
      panel_branches_ms: typeof routeProbes.branch.value === 'number'
        ? routeProbes.branch.value
        : nullMetric(routeProbes.branch.note),
      runtime_inventory_ms: typeof routeProbes.inventory.value === 'number'
        ? routeProbes.inventory.value
        : nullMetric(routeProbes.inventory.note),
    };
  } finally {
    await browser.close();
  }
}

async function main() {
  const baseUrl = (process.env.BASE_URL || `http://127.0.0.1:${readPort()}`).replace(/\/$/, '');
  const target = await readTarget(baseUrl);
  let metrics;
  try {
    metrics = await measureBrowserBoot();
  } catch (error) {
    metrics = emptyMetrics(`browser boot measurement failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  console.log(`O8_BROWSER_BOOT_RECEIPT=${JSON.stringify({ target, metrics })}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
