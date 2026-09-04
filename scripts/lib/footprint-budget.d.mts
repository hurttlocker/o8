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

/**
 * A churned child's retained identity. Every field is drawn from the closed
 * descriptor vocabulary or the process tree's structure — nothing here is
 * derived from the raw command line, not even as a hash.
 */
export interface FootprintChurnIdentity {
  lifecycle: 'spawned' | 'exited';
  component: string;
  descriptor: string;
  depthFromRoot: number | null;
  parentComponent: string;
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
    identities: FootprintChurnIdentity[];
    truncatedIdentityCount: number;
  };
  physicalMeasurementSkippedProcessCount?: number;
  appBundleBytes: number;
  isolatedDataBytes?: number;
  updaterArchiveBytes?: number;
  components: Record<string, FootprintComponent>;
}

export const FOOTPRINT_SAMPLE_LIMITS: {
  defaultSamples: number;
  maxSamples: number;
};

export const FOOTPRINT_BUDGET: {
  version: number;
  targets: Readonly<Record<string, number>>;
  regressionCeilings: Readonly<Record<string, number>>;
};

export function parseFootprintBytes(output: string): number;
export function sanitizeCommandDescriptor(command: string): string;
export function redactedDigest(value: string): string;
export function resolveIdleSampleCount(value?: string | number | null, limits?: typeof FOOTPRINT_SAMPLE_LIMITS): number;
export interface FileHashIo {
  openSync(path: string, flags: string): number;
  readSync(handle: number, buffer: Buffer, offset: number, length: number, position: number | null): number;
  closeSync(handle: number): void;
}

export function hashFileBytes(filePath: string, options?: { chunkBytes?: number; io?: FileHashIo }): string;
export function computeArtifactDigest(appPath: string, options?: {
  version?: string;
  gitSha?: string;
  /** Overrides the default `<appPath>/Contents/MacOS/o8` Mach-O location. */
  executablePath?: string;
  chunkBytes?: number;
  io?: FileHashIo;
}): string;
export function buildChurnIdentities(input: {
  spawned: Set<number>;
  exited: Set<number>;
  before: Map<number, FootprintProcess>;
  after: Map<number, FootprintProcess>;
  beforeOwned: Set<number>;
  afterOwned: Set<number>;
  rootPid: number;
  limit?: number;
}): { identities: FootprintChurnIdentity[]; truncatedIdentityCount: number };
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
  artifactDigest?: string;
  laneCount?: number;
  recordedAt?: string;
  run?: (command: string, args: string[], options?: { encoding?: string }) => string;
}): FootprintSampleReceipt;

export interface FootprintSampleReceipt {
  schemaVersion: number;
  budgetVersion: number;
  version: string;
  gitSha: string;
  mode: string;
  scenario: string;
  artifactDigest?: string;
  laneCount?: number;
  recordedAt: string;
  metrics: FootprintMetrics;
  targets: Readonly<Record<string, number>>;
  regressionCeilings: Readonly<Record<string, number>>;
  verdict: 'PASS' | 'FAIL';
  checks: Array<{ metric: string; actual: number; ceiling: number; pass: boolean }>;
}

export interface FootprintValueSummary {
  min: number;
  max: number;
  mean: number;
  median: number;
}

export interface FootprintSampleAggregate {
  sampleCount: number;
  metrics: Record<string, FootprintValueSummary>;
  checks: Array<{ metric: string; actual: number; ceiling: number; pass: boolean }>;
  failures: Array<{ metric: string; actual: number; ceiling: number; pass: boolean }>;
  verdict: 'PASS' | 'FAIL';
}

// The series helpers only read the identity, metrics, and checks of a sample,
// so they accept anything shaped like one — including fixtures that omit the
// budget tables a real receipt carries.
export type FootprintSampleInput = Omit<FootprintSampleReceipt, 'targets' | 'regressionCeilings'>;

export function assertSameArtifact(samples: FootprintSampleInput[]): void;
export function summarizeFootprintSamples(samples: FootprintSampleInput[]): FootprintSampleAggregate;
export function buildFootprintSeriesReceipt(input: {
  samples: FootprintSampleInput[];
  loadScenario: unknown;
}): {
  schemaVersion: number;
  budgetVersion: number;
  version: string;
  gitSha: string;
  mode: string;
  scenario: string;
  artifactDigest?: string;
  recordedAt: string;
  sampleCount: number;
  samples: Array<{
    index: number;
    recordedAt: string;
    metrics: FootprintMetrics;
    verdict: 'PASS' | 'FAIL';
    checks: Array<{ metric: string; actual: number; ceiling: number; pass: boolean }>;
  }>;
  aggregate: FootprintSampleAggregate;
  metrics: FootprintMetrics;
  targets: Readonly<Record<string, number>>;
  regressionCeilings: Readonly<Record<string, number>>;
  verdict: 'PASS' | 'FAIL';
  checks: Array<{ metric: string; actual: number; ceiling: number; pass: boolean }>;
  loadScenario: unknown;
};
