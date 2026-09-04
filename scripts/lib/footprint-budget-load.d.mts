import type {
  FootprintChurnIdentity,
  FootprintSampleAggregate,
  FootprintSampleInput,
} from './footprint-budget.d.mts';

export const LOAD_SCENARIO_LIMITS: {
  maxLaneCount: number;
  activationTimeoutMs: number;
  drainTimeoutMs: number;
  pollMs: number;
};

export const LOAD_UNAVAILABLE_REASONS: Readonly<Record<string, string>>;
export const LOAD_RUNTIME_BINARIES: Readonly<Record<string, string>>;
export const LOAD_TERMINAL_LANE_STATUSES: readonly string[];
export interface LoadScenarioRequest {
  laneCount: number;
  repoPath?: string | null;
  runtime?: string;
}

export interface LoadScenarioResidualCounts {
  lanes: number;
  childProcesses: number;
  worktrees: number;
  listeners: number;
}

export interface LoadScenarioResiduals {
  counts: LoadScenarioResidualCounts;
  preservedWorktrees: Array<{ digest: string; insideLoadRepo: boolean }>;
  preservedLanes: Array<{ packetDigest: string; status: string }>;
  preservedChildProcesses: FootprintChurnIdentity[];
  truncatedChildProcessIdentityCount: number;
  preservedListeners: Array<{ transport: 'tcp'; state: 'listening' }>;
  truncatedListenerIdentityCount: number;
}

export interface LoadScenarioScope {
  missionId: string | null;
  packetIds: string[];
}

export interface LoadScenarioTeardown {
  packetCount: number;
  stopped: number;
  refused: number;
  residuals: LoadScenarioResiduals;
}

export type LoadScenarioPlan =
  | { available: false; reason: string; detail?: unknown }
  | { available: true; laneCount: number; runtime: string; binaryName: string; repoPath: string };

export interface LoadScenarioBaseline {
  activeLaneCount: number;
  worktrees: Set<string>;
  pids: Set<number>;
  ports: Set<number>;
}

export interface LoadScenarioDisposition {
  packetId: string;
  stage: 'stop';
  outcome: 'stopped' | 'refused';
  message?: string;
}

export interface LoadScenarioDriver {
  captureBaseline(): Promise<LoadScenarioBaseline>;
  createScopedLanes(laneCount: number): Promise<LoadScenarioScope>;
  dispatchScopedLanes(scope: LoadScenarioScope): Promise<void>;
  waitForActiveLanes(scope: LoadScenarioScope, deadline?: number): Promise<boolean>;
  releaseScopedLanes(scope: LoadScenarioScope): Promise<LoadScenarioDisposition[]>;
  collectResiduals(baseline: LoadScenarioBaseline, scope: LoadScenarioScope): Promise<LoadScenarioResiduals>;
  waitForResiduals(
    baseline: LoadScenarioBaseline,
    scope: LoadScenarioScope,
    deadline?: number,
  ): Promise<LoadScenarioResiduals>;
}

export type LoadScenarioResult =
  | { available: false; reason: string; detail?: unknown; laneCount?: number; teardown?: LoadScenarioTeardown }
  | {
    available: true;
    laneCount: number;
    sampleCount: number;
    samples: Array<{
      index: number;
      recordedAt: string;
      metrics: FootprintSampleInput['metrics'];
      verdict: 'PASS' | 'FAIL';
      checks: FootprintSampleInput['checks'];
    }>;
    runtime: string;
    aggregate: FootprintSampleAggregate;
    teardown: LoadScenarioTeardown;
  };

export function resolveLoadScenarioRequest(
  env?: Record<string, string | undefined>,
  limits?: typeof LOAD_SCENARIO_LIMITS,
): LoadScenarioRequest;

export type RegisteredOperatorRepos =
  | { readable: true; paths: string[] }
  | { readable: false; detail?: unknown };

export interface LoadScenarioProbes {
  pathExists(target: string): boolean;
  isLiveOperatorPath(target: string): boolean;
  isReleaseCheckoutPath(target: string): boolean;
  registeredOperatorRepos(): RegisteredOperatorRepos;
  binaryAvailable(binaryName: string): boolean;
  apiTokenAvailable(): boolean;
}

export function planLoadScenario(input: {
  request: LoadScenarioRequest;
  probes: LoadScenarioProbes;
}): LoadScenarioPlan;

export function isLiveOperatorPath(target: string, homeDir: string): boolean;
export function pathsOverlap(left: string, right: string): boolean;
export function isReleaseCheckoutPath(target: string, checkoutRoot: string): boolean;
export function findRegisteredOperatorRepo(target: string, registeredPaths: string[]): string | null;
export function readRegisteredOperatorRepoPaths(
  dataDir: string,
  io?: {
    readFileSync(target: string, encoding: 'utf8'): string;
  },
): RegisteredOperatorRepos;
export function createLoadScenarioProbes(input: {
  checkoutRoot: string;
  operatorDataDir: string;
  homeDir: string;
  binaryAvailable(binaryName: string): boolean;
  apiTokenAvailable(): boolean;
  pathExists?(target: string): boolean;
  readRegistered?(dataDir: string): RegisteredOperatorRepos;
}): LoadScenarioProbes;
export function planGateLoadScenario(input: {
  env: Record<string, string | undefined>;
  checkoutRoot: string;
  operatorDataDir: string;
  homeDir: string;
  binaryAvailable(binaryName: string): boolean;
  apiTokenAvailable(): boolean;
  pathExists?(target: string): boolean;
  readRegistered?(dataDir: string): RegisteredOperatorRepos;
}): { request: LoadScenarioRequest; plan: LoadScenarioPlan };
export function unwrapOperatorResult(payload: unknown, route: string): Record<string, unknown> | null;
export function isActiveLaneStatus(status: unknown): boolean;
export function parseWorktreePaths(output: string): string[];
export function parseListeningPorts(output: string): Set<number>;
export function listeningPortsForPids(
  pids: Set<number>,
  run?: (command: string, args: string[], options?: { encoding?: string }) => string,
): Set<number>;

export function createHttpLoadDriver(input: {
  apiBase: string;
  token: string;
  repoPath: string;
  runtime: string;
  rootPid: number;
  fetchImpl?: typeof fetch;
  run?: (command: string, args: string[], options?: { encoding?: string }) => string;
  snapshot?: (run?: unknown) => Map<number, { pid: number; ppid: number; cpuTimeSeconds: number; command: string }>;
  limits?: typeof LOAD_SCENARIO_LIMITS;
  now?: () => number;
}): LoadScenarioDriver;

export function runLoadScenario(input: {
  plan: LoadScenarioPlan;
  driver: LoadScenarioDriver;
  sample(input: { laneCount: number }): Promise<FootprintSampleInput[]>;
}): Promise<LoadScenarioResult>;
