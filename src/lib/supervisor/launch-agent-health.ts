import { getDataDir } from '@/lib/data-dir-migration';
import {
  launchAgentFailureCount,
  OPERATOR_MCP_LAUNCH_AGENT_LABEL,
  readLaunchAgentCounters,
  readLaunchAgentStarts,
} from '@/lib/mcp/launch-agent-crash-counter';
import { enqueueInboxItem } from '@/lib/supervisor/inbox';

const ALERT_AFTER_FAILURES = 3;
const lastSurfacedFailureCounts = new Map<string, number>();

export interface LaunchAgentCrashLoopAlert {
  label: string;
  failureCount: number;
}

function surfaceCounter(label: string, startsMs: number[], nowMs: number): LaunchAgentCrashLoopAlert | null {
  const failureCount = launchAgentFailureCount(startsMs, nowMs);
  if (failureCount < ALERT_AFTER_FAILURES) {
    lastSurfacedFailureCounts.delete(label);
    return null;
  }
  if (failureCount <= (lastSurfacedFailureCounts.get(label) ?? 0)) {
    return null;
  }
  const dataDir = getDataDir();
  enqueueInboxItem({
    repoPath: dataDir,
    packetId: null,
    kind: 'launch_agent_crash_loop',
    status: 'human_required',
    payload: {
      label,
      failureCount,
      windowMinutes: 60,
      summary: `${label} failed ${failureCount} times in the last hour`,
    },
  });
  lastSurfacedFailureCounts.set(label, failureCount);
  return { label, failureCount };
}

export function surfaceLaunchAgentCrashLoops(nowMs = Date.now()): LaunchAgentCrashLoopAlert[] {
  const counters = readLaunchAgentCounters(getDataDir(), nowMs);
  const labels = new Set(counters.map((counter) => counter.label));
  for (const label of lastSurfacedFailureCounts.keys()) {
    if (!labels.has(label)) lastSurfacedFailureCounts.delete(label);
  }
  return counters
    .map((counter) => surfaceCounter(counter.label, counter.startsMs, nowMs))
    .filter((alert): alert is LaunchAgentCrashLoopAlert => alert !== null);
}

export function surfaceLaunchAgentCrashLoop(nowMs = Date.now()): number {
  const dataDir = getDataDir();
  return surfaceCounter(
    OPERATOR_MCP_LAUNCH_AGENT_LABEL,
    readLaunchAgentStarts(dataDir, nowMs),
    nowMs,
  )?.failureCount ?? 0;
}
