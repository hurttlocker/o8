import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';

export const OPERATOR_MCP_LAUNCH_AGENT_LABEL = 'com.rainwater.mcp-o8';
export const LAUNCH_AGENT_WINDOW_MS = 60 * 60_000;
export const LAUNCH_AGENT_HEALTHY_UPTIME_MS = 5 * 60_000;
export const LAUNCH_AGENT_STARTED_AT_ENV = 'O8_LAUNCH_AGENT_STARTED_AT_MS';

export interface LaunchAgentCounterFile {
  label: string;
  startsMs: number[];
}

function resolveCounterDataDir(): string {
  return getDataDir();
}

export function resolveLaunchAgentLabel(
  env: Record<string, string | undefined> = process.env,
): string {
  const serviceName = env.XPC_SERVICE_NAME?.trim();
  return serviceName && serviceName !== '0'
    ? serviceName
    : OPERATOR_MCP_LAUNCH_AGENT_LABEL;
}

function counterFileName(label: string): string {
  return `${label.replace(/[^a-zA-Z0-9._-]/g, '_')}.json`;
}

export function launchAgentCounterPath(
  dataDir = resolveCounterDataDir(),
  label = OPERATOR_MCP_LAUNCH_AGENT_LABEL,
): string {
  return join(dataDir, 'health', counterFileName(label));
}

function recentStarts(startsMs: number[], nowMs: number): number[] {
  const floor = nowMs - LAUNCH_AGENT_WINDOW_MS;
  return startsMs.filter((timestamp) => Number.isFinite(timestamp) && timestamp >= floor && timestamp <= nowMs);
}

function readCounterFile(counterPath: string, nowMs: number): LaunchAgentCounterFile | null {
  try {
    const parsed = JSON.parse(readFileSync(counterPath, 'utf8')) as Partial<LaunchAgentCounterFile>;
    if (typeof parsed.label !== 'string' || !parsed.label.trim() || !Array.isArray(parsed.startsMs)) {
      return null;
    }
    return { label: parsed.label, startsMs: recentStarts(parsed.startsMs, nowMs) };
  } catch {
    return null;
  }
}

function writeCounterFile(dataDir: string | undefined, counter: LaunchAgentCounterFile): void {
  const counterPath = launchAgentCounterPath(dataDir, counter.label);
  const tempPath = `${counterPath}.${process.pid}.tmp`;
  mkdirSync(dirname(counterPath), { recursive: true });
  writeFileSync(tempPath, `${JSON.stringify(counter)}\n`, 'utf8');
  renameSync(tempPath, counterPath);
}

export function readLaunchAgentStarts(
  dataDir?: string,
  nowMs = Date.now(),
  label = OPERATOR_MCP_LAUNCH_AGENT_LABEL,
): number[] {
  return readCounterFile(launchAgentCounterPath(dataDir, label), nowMs)?.startsMs ?? [];
}

export function readLaunchAgentCounters(dataDir?: string, nowMs = Date.now()): LaunchAgentCounterFile[] {
  const healthDir = dirname(launchAgentCounterPath(dataDir));
  try {
    return readdirSync(healthDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => readCounterFile(join(healthDir, entry.name), nowMs))
      .filter((counter): counter is LaunchAgentCounterFile => counter !== null);
  } catch {
    return [];
  }
}

export function recordLaunchAgentStart(options: {
  dataDir?: string;
  label?: string;
  nowMs?: number;
  parentPid?: number;
} = {}): number {
  const parentPid = options.parentPid ?? process.ppid;
  if (parentPid !== 1) {
    return 0;
  }
  const nowMs = options.nowMs ?? Date.now();
  const label = options.label ?? resolveLaunchAgentLabel();
  const startsMs = [...readLaunchAgentStarts(options.dataDir, nowMs, label), nowMs];
  try {
    writeCounterFile(options.dataDir, { label, startsMs });
  } catch (error) {
    console.error(`[o8 operator MCP] failed to record LaunchAgent start for ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return startsMs.length;
}

export function markLaunchAgentHealthy(options: {
  dataDir?: string;
  label?: string;
  nowMs?: number;
  startedAtMs?: number;
} = {}): boolean {
  const nowMs = options.nowMs ?? Date.now();
  const label = options.label ?? resolveLaunchAgentLabel();
  const startsMs = readLaunchAgentStarts(options.dataDir, nowMs, label);
  if (!startsMs.length || (
    options.startedAtMs !== undefined
    && startsMs.at(-1) !== options.startedAtMs
  )) {
    return false;
  }
  try {
    writeCounterFile(options.dataDir, { label, startsMs: [] });
    return true;
  } catch (error) {
    console.error(`[o8 operator MCP] failed to mark LaunchAgent ${label} healthy: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

export function launchAgentFailureCount(startsMs: number[], nowMs = Date.now()): number {
  return Math.max(0, recentStarts(startsMs, nowMs).length - 1);
}
