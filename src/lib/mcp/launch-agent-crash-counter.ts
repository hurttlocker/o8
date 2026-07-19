import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const OPERATOR_MCP_LAUNCH_AGENT_LABEL = 'com.rainwater.mcp-o8';
export const LAUNCH_AGENT_WINDOW_MS = 60 * 60_000;

interface LaunchAgentCounterFile {
  label: string;
  startsMs: number[];
}

function resolveCounterDataDir(): string {
  return process.env.O8_DATA_DIR
    || process.env.CORTEX_IDE_DATA_DIR
    || join(homedir(), '.o8');
}

export function launchAgentCounterPath(dataDir = resolveCounterDataDir()): string {
  return join(dataDir, 'health', `${OPERATOR_MCP_LAUNCH_AGENT_LABEL}.json`);
}

function recentStarts(startsMs: number[], nowMs: number): number[] {
  const floor = nowMs - LAUNCH_AGENT_WINDOW_MS;
  return startsMs.filter((timestamp) => Number.isFinite(timestamp) && timestamp >= floor && timestamp <= nowMs);
}

export function readLaunchAgentStarts(dataDir?: string, nowMs = Date.now()): number[] {
  try {
    const parsed = JSON.parse(readFileSync(launchAgentCounterPath(dataDir), 'utf8')) as Partial<LaunchAgentCounterFile>;
    return recentStarts(Array.isArray(parsed.startsMs) ? parsed.startsMs : [], nowMs);
  } catch {
    return [];
  }
}

export function recordLaunchAgentStart(options: {
  dataDir?: string;
  nowMs?: number;
  parentPid?: number;
} = {}): number {
  const parentPid = options.parentPid ?? process.ppid;
  if (parentPid !== 1) {
    return 0;
  }
  const nowMs = options.nowMs ?? Date.now();
  const startsMs = [...readLaunchAgentStarts(options.dataDir, nowMs), nowMs];
  const counterPath = launchAgentCounterPath(options.dataDir);
  const tempPath = `${counterPath}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(counterPath), { recursive: true });
    writeFileSync(tempPath, `${JSON.stringify({
      label: OPERATOR_MCP_LAUNCH_AGENT_LABEL,
      startsMs,
    } satisfies LaunchAgentCounterFile)}\n`, 'utf8');
    renameSync(tempPath, counterPath);
  } catch (error) {
    console.error(`[o8 operator MCP] failed to record LaunchAgent start: ${error instanceof Error ? error.message : String(error)}`);
  }
  return startsMs.length;
}

export function launchAgentFailureCount(startsMs: number[], nowMs = Date.now()): number {
  return Math.max(0, recentStarts(startsMs, nowMs).length - 1);
}
