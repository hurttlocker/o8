export interface FootprintProcess {
  pid: number;
  ppid: number;
  cpuTimeSeconds: number;
  command: string;
}

export interface FootprintComponent {
  processCount?: number;
  bytes: number;
  cpuPercent?: number;
}

export interface FootprintMetrics {
  observationMs?: number;
  idlePhysicalBytes: number;
  idleCpuPercent: number;
  idleProcessChurn: number;
  idleProcessSpawnsPerMinute?: number;
  idleProcessExitsPerMinute?: number;
  processChurn?: {
    spawnedByComponent: Record<string, number>;
    exitedByComponent: Record<string, number>;
  };
  physicalMeasurementSkippedProcessCount?: number;
  appBundleBytes: number;
  isolatedDataBytes?: number;
  updaterArchiveBytes?: number;
  components: Record<string, FootprintComponent>;
}

export const FOOTPRINT_BUDGET: {
  version: number;
  targets: Readonly<Record<string, number>>;
  regressionCeilings: Readonly<Record<string, number>>;
};

export function parseFootprintBytes(output: string): number;
export function parseCpuTimeSeconds(value: string): number;
export function parseProcessTable(output: string): Map<number, FootprintProcess>;
export function snapshotProcesses(run?: typeof import('node:child_process').execFileSync): Map<number, FootprintProcess>;
export function descendantPids(processes: Map<number, FootprintProcess>, rootPid: number): Set<number>;
export function webkitPids(processes: Map<number, FootprintProcess>): Set<number>;
export function measureProcessPhysicalBytes(pid: number, run?: typeof import('node:child_process').execFileSync): number;
export function evaluateFootprintBudget(metrics: FootprintMetrics, budget?: typeof FOOTPRINT_BUDGET): {
  pass: boolean;
  checks: Array<{ metric: string; actual: number; ceiling: number; pass: boolean }>;
  failures: Array<{ metric: string; actual: number; ceiling: number; pass: boolean }>;
};
export function collectFootprintReceipt(input: {
  rootPid: number;
  appPath: string;
  dataDir: string;
  updaterArchivePath?: string;
  webkitBaseline: Set<number>;
  before: Map<number, FootprintProcess>;
  after: Map<number, FootprintProcess>;
  observationMs: number;
  version: string;
  gitSha: string;
  mode: string;
  scenario: string;
  recordedAt?: string;
  run?: (command: string, args: string[], options?: { encoding?: string }) => string;
}): {
  schemaVersion: number;
  budgetVersion: number;
  version: string;
  gitSha: string;
  mode: string;
  scenario: string;
  recordedAt: string;
  metrics: FootprintMetrics;
  targets: Readonly<Record<string, number>>;
  regressionCeilings: Readonly<Record<string, number>>;
  verdict: 'PASS' | 'FAIL';
  checks: Array<{ metric: string; actual: number; ceiling: number; pass: boolean }>;
};
