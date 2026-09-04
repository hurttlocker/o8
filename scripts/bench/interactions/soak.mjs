// Bounded idle-soak measurement and resource attribution for the interaction
// harness. Kept separate from the scenario driver so process sampling cannot
// push the entrypoint over the repository file ceiling.
import { execFileSync } from 'node:child_process';
import { snapshotProcesses } from '../../lib/footprint-budget.mjs';
import {
  measureProcessGroupMemory,
  resolveProcessGroups,
  sleep,
} from '../terminal-workload/runtime.mjs';
import { readSoakCounters } from './page-instrumentation.mjs';

function socketCount(wsPort) {
  try {
    const output = execFileSync('lsof', ['-nP', `-iTCP:${wsPort}`, '-sTCP:ESTABLISHED'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const rows = output.split('\n').slice(1).filter((line) => line.trim());
    return { value: rows.length, note: null };
  } catch (error) {
    return { value: null, note: `socket count unavailable: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function processObservation() {
  try {
    return { ok: true, processes: snapshotProcesses(), note: null };
  } catch (error) {
    return { ok: false, processes: null, note: `process table unavailable: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function guardedGroupMemory(processes, groups) {
  try {
    return { bytes: measureProcessGroupMemory(processes, groups), note: null };
  } catch (error) {
    return { bytes: {}, note: `process memory unavailable: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export function stableSoakGroups(processes, groups, stack) {
  const stable = (pids, rootPid, predicate) => pids.filter((pid) => {
    const process = processes.get(pid);
    return pid === rootPid || predicate(process?.command ?? '');
  });
  return {
    applicationServer: stable(groups.applicationServer ?? [], stack.nextPid, (command) => (
      command.includes('next-server') || command.includes('/server.js')
    )),
    realtimeServer: stable(groups.realtimeServer ?? [], stack.wsPid, (command) => command.includes('ws-server')),
    chromiumRenderer: stable(groups.chromiumRenderer ?? [], null, (command) => command.includes('--type=renderer')),
  };
}

export async function runSoak(page, stack, browserPid, soakMs) {
  if (soakMs <= 0) return { unavailableReason: 'soak disabled (--soak-ms=0)' };
  const before = processObservation();
  const observedGroups = before.ok ? resolveProcessGroups(before.processes, stack, browserPid) : {};
  const memoryGroups = before.ok ? stableSoakGroups(before.processes, observedGroups, stack) : {};
  const excludedTransientProcesses = Object.fromEntries(Object.keys(observedGroups).map((name) => [
    name,
    Math.max(0, (observedGroups[name]?.length ?? 0) - (memoryGroups[name]?.length ?? 0)),
  ]));
  const start = before.ok ? guardedGroupMemory(before.processes, memoryGroups) : { bytes: {}, note: before.note };
  const since = await page.evaluate(() => performance.now());
  await sleep(soakMs);
  // Freeze the bounded browser observation before resource probes. `footprint`
  // is external tooling and must never stretch the soak denominator.
  const counters = await page.evaluate(readSoakCounters, since);
  const after = processObservation();
  const end = after.ok ? guardedGroupMemory(after.processes, memoryGroups) : { bytes: {}, note: after.note };
  const observedMinutes = counters.observedMs / 60_000;
  const excludedCount = Object.values(excludedTransientProcesses).reduce((total, value) => total + value, 0);
  const memoryScopeNote = excludedCount > 0
    ? `physical memory covers stable serving/render processes; excluded ${excludedCount} transient workload processes captured at the boundary`
    : null;
  const resourceNote = [before.note, after.note, start.note, end.note, memoryScopeNote].filter(Boolean).join('; ') || null;
  const growth = (name) => (
    Number.isFinite(start.bytes[name]) && Number.isFinite(end.bytes[name]) ? end.bytes[name] - start.bytes[name] : null
  );
  const groupNames = Object.keys(observedGroups);
  return {
    durationMs: Number(counters.observedMs.toFixed(2)),
    longTaskMsPerMinute: counters.longTaskSupported && observedMinutes > 0
      ? Number((counters.longTaskMs / observedMinutes).toFixed(2))
      : null,
    longTaskUnavailableReason: counters.longTaskSupported ? null : 'the browser does not expose longtask entries',
    longTaskCount: counters.longTaskSupported ? counters.longTaskCount : null,
    processCount: after.ok
      ? Object.fromEntries(groupNames.map((name) => [name, observedGroups[name].filter((pid) => after.processes.has(pid)).length]))
      : null,
    physicalBytes: Object.fromEntries(groupNames.map((name) => [name, end.bytes[name] ?? null])),
    physicalBytesGrowth: Object.fromEntries(groupNames.map((name) => [name, growth(name)])),
    physicalMemoryExcludedTransientProcesses: excludedTransientProcesses,
    webSocketCount: socketCount(stack.wsPort),
    resourceUnavailableReason: resourceNote,
    unavailableReason: null,
  };
}
