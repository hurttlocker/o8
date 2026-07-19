import { getDataDir } from '@/lib/data-dir-migration';
import {
  launchAgentFailureCount,
  OPERATOR_MCP_LAUNCH_AGENT_LABEL,
  readLaunchAgentStarts,
} from '@/lib/mcp/launch-agent-crash-counter';
import { enqueueInboxItem } from '@/lib/supervisor/inbox';

const ALERT_AFTER_FAILURES = 3;
let lastSurfacedFailureCount = 0;

export function surfaceLaunchAgentCrashLoop(nowMs = Date.now()): number {
  const dataDir = getDataDir();
  const failureCount = launchAgentFailureCount(readLaunchAgentStarts(dataDir, nowMs), nowMs);
  if (failureCount < ALERT_AFTER_FAILURES) {
    lastSurfacedFailureCount = 0;
    return 0;
  }
  if (failureCount <= lastSurfacedFailureCount) {
    return 0;
  }
  enqueueInboxItem({
    repoPath: dataDir,
    packetId: null,
    kind: 'launch_agent_crash_loop',
    status: 'human_required',
    payload: {
      label: OPERATOR_MCP_LAUNCH_AGENT_LABEL,
      failureCount,
      windowMinutes: 60,
      summary: `${OPERATOR_MCP_LAUNCH_AGENT_LABEL} failed ${failureCount} times in the last hour`,
    },
  });
  lastSurfacedFailureCount = failureCount;
  return failureCount;
}
