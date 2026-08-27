import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

export const FOOTPRINT_BUDGET = Object.freeze({
  version: 1,
  targets: Object.freeze({
    appBundleBytes: 250 * MIB,
    updaterArchiveBytes: 75 * MIB,
    idlePhysicalBytes: 1 * GIB,
    idleCpuPercent: 5,
    nativeHostCpuPercent: 2,
    applicationServerCpuPercent: 5,
    realtimeServerCpuPercent: 5,
    webkitHelpersCpuPercent: 1,
    idleProcessSpawnsPerMinute: 0,
    persistentDataBytes: 1 * GIB,
  }),
  regressionCeilings: Object.freeze({
    appBundleBytes: 250 * MIB,
    updaterArchiveBytes: 75 * MIB,
    idlePhysicalBytes: 1536 * MIB,
    idleCpuPercent: 15,
    idleProcessChurn: 0,
    nativeHostCpuPercent: 5,
    applicationServerCpuPercent: 12,
    realtimeServerCpuPercent: 8,
    webkitHelpersCpuPercent: 10,
    nativeHostBytes: 640 * MIB,
    applicationServerBytes: 512 * MIB,
    realtimeServerBytes: 256 * MIB,
    webkitHelpersBytes: 512 * MIB,
  }),
});

const UNIT_BYTES = Object.freeze({
  B: 1,
  KB: 1024,
  MB: MIB,
  GB: GIB,
  TB: 1024 * GIB,
});

export function parseFootprintBytes(output) {
  const match = String(output).match(/\bFootprint:\s*([\d.]+)\s*(B|KB|MB|GB|TB)\b/);
  if (!match) throw new Error('physical footprint was absent from footprint output');
  const bytes = Number(match[1]) * UNIT_BYTES[match[2]];
  if (!Number.isFinite(bytes) || bytes < 0) throw new Error('physical footprint was invalid');
  return Math.round(bytes);
}

export function parseCpuTimeSeconds(value) {
  const match = String(value).trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/);
  if (!match) throw new Error(`invalid CPU time: ${value}`);
  const days = Number(match[1] ?? 0);
  const hours = Number(match[2] ?? 0);
  const minutes = Number(match[3]);
  const seconds = Number(match[4]);
  return (((days * 24) + hours) * 60 + minutes) * 60 + seconds;
}

export function parseProcessTable(output) {
  const processes = new Map();
  for (const line of String(output).split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+\S+\s+\S+\s+\d+\s+\S+\s+\d+\s+(\S+)\s+(.*)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    processes.set(pid, {
      pid,
      ppid: Number(match[2]),
      cpuTimeSeconds: parseCpuTimeSeconds(match[3]),
      command: match[4].trim(),
    });
  }
  return processes;
}

export function snapshotProcesses(run = execFileSync) {
  return parseProcessTable(run('ps', ['-axo', 'pid=,ppid=,lstart=,time=,command='], { encoding: 'utf8' }));
}

export function descendantPids(processes, rootPid) {
  const found = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const process of processes.values()) {
      if (!found.has(process.pid) && found.has(process.ppid)) {
        found.add(process.pid);
        changed = true;
      }
    }
  }
  return found;
}

export function webkitPids(processes) {
  return new Set([...processes.values()]
    .filter((process) => process.command.includes('/WebKit.framework/') && process.command.includes('.xpc/'))
    .map((process) => process.pid));
}

function setDifference(left, right) {
  return new Set([...left].filter((value) => !right.has(value)));
}

function classifyProcess(process, rootPid) {
  if (process.pid === rootPid) return 'nativeHost';
  if (process.command.includes('WebKit.WebContent')) return 'webkitContent';
  if (process.command.includes('WebKit.GPU')) return 'webkitGpu';
  if (process.command.includes('WebKit.Networking')) return 'webkitNetwork';
  if (process.command.includes('next-server')) return 'applicationServer';
  if (process.command.includes('ws-server.mjs')) return 'realtimeServer';
  if (process.command.includes('speech_recognizer')) return 'speechHelper';
  return 'otherChild';
}

function ownedPids(processes, rootPid, webkitBaseline) {
  const descendants = descendantPids(processes, rootPid);
  const newWebkit = setDifference(webkitPids(processes), webkitBaseline);
  return new Set([...descendants, ...newWebkit]);
}

function measureDiskBytes(target, run = execFileSync) {
  const output = run('du', ['-sk', target], { encoding: 'utf8' });
  const kib = Number(String(output).trim().split(/\s+/)[0]);
  if (!Number.isFinite(kib) || kib < 0) throw new Error(`invalid disk usage for ${target}`);
  return kib * 1024;
}

function measurePhysicalBytes(pid, run = execFileSync) {
  const output = run('footprint', ['-p', String(pid)], { encoding: 'utf8' });
  return parseFootprintBytes(output);
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function evaluateFootprintBudget(metrics, budget = FOOTPRINT_BUDGET) {
  const webkitBytes = (
    (metrics.components.webkitContent?.bytes ?? 0)
    + (metrics.components.webkitGpu?.bytes ?? 0)
    + (metrics.components.webkitNetwork?.bytes ?? 0)
  );
  const webkitCpuPercent = (
    (metrics.components.webkitContent?.cpuPercent ?? 0)
    + (metrics.components.webkitGpu?.cpuPercent ?? 0)
    + (metrics.components.webkitNetwork?.cpuPercent ?? 0)
  );
  const checks = [
    ['appBundleBytes', metrics.appBundleBytes, budget.regressionCeilings.appBundleBytes],
    ['idlePhysicalBytes', metrics.idlePhysicalBytes, budget.regressionCeilings.idlePhysicalBytes],
    ['idleCpuPercent', metrics.idleCpuPercent, budget.regressionCeilings.idleCpuPercent],
    ['idleProcessChurn', metrics.idleProcessChurn, budget.regressionCeilings.idleProcessChurn],
    ['nativeHostCpuPercent', metrics.components.nativeHost?.cpuPercent ?? 0, budget.regressionCeilings.nativeHostCpuPercent],
    ['applicationServerCpuPercent', metrics.components.applicationServer?.cpuPercent ?? 0, budget.regressionCeilings.applicationServerCpuPercent],
    ['realtimeServerCpuPercent', metrics.components.realtimeServer?.cpuPercent ?? 0, budget.regressionCeilings.realtimeServerCpuPercent],
    ['webkitHelpersCpuPercent', webkitCpuPercent, budget.regressionCeilings.webkitHelpersCpuPercent],
    ['nativeHostBytes', metrics.components.nativeHost?.bytes ?? 0, budget.regressionCeilings.nativeHostBytes],
    ['applicationServerBytes', metrics.components.applicationServer?.bytes ?? 0, budget.regressionCeilings.applicationServerBytes],
    ['realtimeServerBytes', metrics.components.realtimeServer?.bytes ?? 0, budget.regressionCeilings.realtimeServerBytes],
    ['webkitHelpersBytes', webkitBytes, budget.regressionCeilings.webkitHelpersBytes],
  ];
  if (typeof metrics.updaterArchiveBytes === 'number') {
    checks.push(['updaterArchiveBytes', metrics.updaterArchiveBytes, budget.regressionCeilings.updaterArchiveBytes]);
  }
  const results = checks.map(([metric, actual, ceiling]) => ({
    metric,
    actual,
    ceiling,
    pass: actual <= ceiling,
  }));
  return {
    pass: results.every((result) => result.pass),
    checks: results,
    failures: results.filter((result) => !result.pass),
  };
}

export function collectFootprintReceipt({
  rootPid,
  appPath,
  dataDir,
  updaterArchivePath,
  webkitBaseline,
  before,
  after,
  observationMs,
  version,
  gitSha,
  mode,
  scenario,
  recordedAt = new Date().toISOString(),
  run = execFileSync,
}) {
  if (!before.has(rootPid) || !after.has(rootPid)) {
    throw new Error('packaged app exited during footprint observation');
  }
  const beforeOwned = ownedPids(before, rootPid, webkitBaseline);
  const afterOwned = ownedPids(after, rootPid, webkitBaseline);
  const spawned = setDifference(afterOwned, beforeOwned);
  const exited = setDifference(beforeOwned, afterOwned);
  const common = new Set([...afterOwned].filter((pid) => beforeOwned.has(pid)));
  let cpuSeconds = 0;
  const cpuSecondsByComponent = {};
  for (const pid of common) {
    const delta = (after.get(pid)?.cpuTimeSeconds ?? 0) - (before.get(pid)?.cpuTimeSeconds ?? 0);
    const boundedDelta = Math.max(0, delta);
    cpuSeconds += boundedDelta;
    const process = after.get(pid);
    if (process) {
      const key = classifyProcess(process, rootPid);
      cpuSecondsByComponent[key] = (cpuSecondsByComponent[key] ?? 0) + boundedDelta;
    }
  }
  const observationSeconds = observationMs / 1000;
  const components = {};
  for (const pid of afterOwned) {
    const process = after.get(pid);
    if (!process) continue;
    const key = classifyProcess(process, rootPid);
    const bytes = measurePhysicalBytes(pid, run);
    const component = components[key] ?? {
      processCount: 0,
      bytes: 0,
      cpuPercent: round(((cpuSecondsByComponent[key] ?? 0) / observationSeconds) * 100),
    };
    component.processCount += 1;
    component.bytes += bytes;
    components[key] = component;
  }
  const idlePhysicalBytes = Object.values(components).reduce((sum, component) => sum + component.bytes, 0);
  const idleProcessChurn = spawned.size + exited.size;
  const metrics = {
    observationMs,
    idlePhysicalBytes,
    idleCpuPercent: round((cpuSeconds / observationSeconds) * 100),
    idleProcessChurn,
    idleProcessSpawnsPerMinute: round(spawned.size * (60_000 / observationMs)),
    idleProcessExitsPerMinute: round(exited.size * (60_000 / observationMs)),
    appBundleBytes: measureDiskBytes(appPath, run),
    isolatedDataBytes: measureDiskBytes(dataDir, run),
    components,
  };
  if (updaterArchivePath) metrics.updaterArchiveBytes = statSync(updaterArchivePath).size;
  const budget = evaluateFootprintBudget(metrics);
  return {
    schemaVersion: 1,
    budgetVersion: FOOTPRINT_BUDGET.version,
    version,
    gitSha,
    mode,
    scenario,
    recordedAt,
    metrics,
    targets: FOOTPRINT_BUDGET.targets,
    regressionCeilings: FOOTPRINT_BUDGET.regressionCeilings,
    verdict: budget.pass ? 'PASS' : 'FAIL',
    checks: budget.checks,
  };
}
