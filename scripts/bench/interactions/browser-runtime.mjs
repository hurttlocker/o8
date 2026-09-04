import { chromium } from 'playwright-core';
import {
  addOwnedProcessRoot,
  captureOwnedProcessTree,
  captureOwnedProcessTreeSafe,
  createOwnedProcessInventory,
  snapshotProcessInventory,
  terminateAndWaitOwnedProcesses,
} from './cleanup.mjs';

export async function launchMeasuredBrowser(browserPath, runTag) {
  const inventory = createOwnedProcessInventory(runTag);
  const browser = await chromium.launch({
    executablePath: browserPath,
    headless: true,
    args: [
      '--disable-background-networking',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      `--o8-interactions-id=${runTag}`,
    ],
  });
  const processes = snapshotProcessInventory();
  const tagged = [...processes.values()].filter((entry) => entry.command.includes(runTag));
  const taggedPids = new Set(tagged.map((entry) => entry.pid));
  const roots = tagged.filter((entry) => !taggedPids.has(entry.ppid));
  for (const root of roots) addOwnedProcessRoot(inventory, root.pid, 'browser', processes);
  captureOwnedProcessTree(inventory, processes);
  const timer = setInterval(() => captureOwnedProcessTreeSafe(inventory), 1_000);
  timer.unref();
  return { browser, browserPid: roots[0]?.pid ?? null, inventory, timer };
}

export async function closeMeasuredBrowser(state) {
  clearInterval(state.timer);
  const closeTimedOut = await Promise.race([
    state.browser.close().then(() => false).catch(() => false),
    new Promise((resolve) => setTimeout(() => resolve(true), 5_000)),
  ]);
  captureOwnedProcessTree(state.inventory);
  return {
    closeTimedOut,
    ...await terminateAndWaitOwnedProcesses(state.inventory, { graceMs: 0 }),
  };
}
